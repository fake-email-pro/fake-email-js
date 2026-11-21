import { defaultSleep, HttpClient, isGatewayStatus, type FetchLike } from "./core.js";
import {
  APIConnectionError,
  APIError,
  FakeEmailError,
  NotFoundError,
  parseRetryAfter,
  RateLimitError,
  WaitTimeoutError,
} from "./errors.js";
import { DomainsResource } from "./resources/domains.js";
import { LimitsResource } from "./resources/limits.js";
import { MailboxesResource } from "./resources/mailboxes.js";
import { MessagesResource, waitOnce } from "./resources/messages.js";
import type { DetailedMessage, SimpleMessage } from "./types.js";
import { VERSION } from "./version.js";

export const DEFAULT_BASE_URL = "https://api.fake-email.pro";

export interface ClientOptions {
  /** API key (`fep_…`). Defaults to the `FAKE_EMAIL_API_KEY` environment variable. */
  apiKey?: string;
  /** Default `https://api.fake-email.pro`. */
  baseUrl?: string;
  /**
   * Per HTTP attempt, in ms, reading the body included (default 30 000). A `wait` request gets its server
   * timeout + 10 s instead.
   */
  timeoutMs?: number;
  /**
   * Retries on 429 and 503 (unless its `Retry-After` is over 5 s), and on 502/504/520–524/timeouts/network
   * errors for GET and DELETE (default 2).
   */
  maxRetries?: number;
  /** A `fetch` implementation; defaults to the global one. */
  fetch?: FetchLike;
  /** Appended to the SDK's own `User-Agent` token, e.g. `"my-e2e-suite/1.0"`. */
  userAgent?: string;
  /** @internal Sleep used between retries and polls; tests replace it to run instantly. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** @internal Clock in ms used for deadlines and `Retry-After` dates. */
  now?: () => number;
  /** @internal Source of backoff jitter in [0, 1). */
  random?: () => number;
}

export interface WaitForMessageOptions {
  /**
   * Client-side deadline for the whole wait, in ms (default 60 000); `<= 0` throws `WaitTimeoutError` at once.
   * Rate limits (429), 502/503/504/520–524, timeouts and network errors are waited out until then.
   */
  timeoutMs?: number;
  /** Only messages strictly after this message id or time (RFC 3339 string or `Date`, server clock). */
  after?: string | Date;
  /** Case-insensitive substring of the sender address (server-side filter). */
  from?: string;
  /** Case-insensitive substring of the subject (server-side filter). */
  subject?: string;
  /** Client-side filter; a message that fails it is skipped and the wait continues after it. */
  match?: (message: SimpleMessage) => boolean | Promise<boolean>;
  signal?: AbortSignal;
}

const DEFAULT_WAIT_FOR_MS = 60_000;
const MAX_SERVER_WAIT_S = 60;
// A 204 that comes back far earlier than asked (a server restart) is not retried in a tight loop.
const EARLY_EMPTY_PAUSE_MS = 1_000;
// Pause after a transient error without Retry-After inside the wait helpers: 1 s, 2 s, 4 s, 4 s, ...
const TRANSIENT_PAUSE_MS = 1_000;
const MAX_TRANSIENT_PAUSE_MS = 4_000;
// The server's phrase for `wait?after=<id>` when that message is gone (backend message.ErrAfterNotFound).
const AFTER_NOT_FOUND = "message in after not found";

/**
 * Client for the fake-email.pro Public API. Server-side only: the key must never reach browser code
 * (the API has no CORS).
 */
export class FakeEmail {
  readonly mailboxes: MailboxesResource;
  readonly messages: MessagesResource;
  readonly domains: DomainsResource;
  readonly limits: LimitsResource;
  readonly baseUrl: string;

  private readonly http: HttpClient;

  constructor(options: ClientOptions = {}) {
    const apiKey = options.apiKey ?? readEnv("FAKE_EMAIL_API_KEY");
    if (!apiKey) {
      throw new FakeEmailError(
        "missing API key: pass { apiKey } or set FAKE_EMAIL_API_KEY (create one at https://fake-email.pro/settings/api-keys)",
      );
    }
    const fetchImpl = options.fetch ?? (typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : undefined);
    if (!fetchImpl) throw new FakeEmailError("no global fetch: use Node 18+ or pass { fetch }");

    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    const sdkToken = `fake-email-pro-js/${VERSION}`;
    this.http = new HttpClient({
      apiKey,
      baseUrl: this.baseUrl,
      timeoutMs: options.timeoutMs ?? 30_000,
      maxRetries: options.maxRetries ?? 2,
      userAgent: options.userAgent ? `${sdkToken} ${options.userAgent}` : sdkToken,
      fetch: fetchImpl,
      sleep: options.sleep ?? defaultSleep,
      now: options.now ?? Date.now,
      random: options.random ?? Math.random,
    });
    this.mailboxes = new MailboxesResource(this.http);
    this.messages = new MessagesResource(this.http);
    this.domains = new DomainsResource(this.http);
    this.limits = new LimitsResource(this.http);
  }

  /**
   * Waits until a matching message arrives, repeating server long polls until `timeoutMs`.
   * Throws `WaitTimeoutError` at the deadline; transient errors (429, 502/503/504/520–524, timeouts, network
   * errors) are waited out until then.
   */
  waitForMessage(address: string, options: WaitForMessageOptions = {}): Promise<SimpleMessage> {
    return this.waitLoop(address, options, async (m) => m);
  }

  /**
   * Waits for a message with a one-time code and returns the code. Uses the code found on delivery, else
   * the first code of the full message; a message without any code is skipped.
   */
  waitForCode(address: string, options: WaitForMessageOptions = {}): Promise<string> {
    return this.waitLoop(address, options, async (m, getFull) => m.code || ((await getFull(m.id)).codes[0] ?? null));
  }

  /**
   * Waits for a message with a confirm / sign-in link and returns its URL. Uses the link found on delivery,
   * else the first link of the full message; a message without links is skipped.
   */
  waitForLink(address: string, options: WaitForMessageOptions = {}): Promise<string> {
    return this.waitLoop(
      address,
      options,
      async (m, getFull) => m.confirmLink || ((await getFull(m.id)).links[0]?.url ?? null),
    );
  }

  private async waitLoop<T>(
    address: string,
    options: WaitForMessageOptions,
    extract: (message: SimpleMessage, getFull: (id: string) => Promise<DetailedMessage>) => Promise<T | null>,
  ): Promise<T> {
    const { now, sleep } = this.http.config;
    const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_FOR_MS;
    const deadline = now() + timeoutMs;
    const { signal } = options;

    // Every request of the helper goes through here: the loop owns retries (each request is sent with
    // maxRetries 0), transient errors are waited out, and nothing sleeps or starts past the deadline.
    const untilDeadline = async <R>(call: (remainingMs: number) => Promise<R>): Promise<R> => {
      for (let failures = 0; ; failures++) {
        signal?.throwIfAborted();
        const remaining = deadline - now();
        if (remaining <= 0) throw new WaitTimeoutError(address, timeoutMs);
        try {
          return await call(remaining);
        } catch (err) {
          if (signal?.aborted) throw signal.reason;
          if (!isTransient(err)) throw err;
          const left = deadline - now();
          if (left <= 0) throw new WaitTimeoutError(address, timeoutMs);
          const retryAfter = err instanceof APIError ? parseRetryAfter(err.headers.get("retry-after"), now()) : null;
          const pause = retryAfter ?? Math.min(TRANSIENT_PAUSE_MS * 2 ** failures, MAX_TRANSIENT_PAUSE_MS);
          await sleep(Math.min(pause, left), signal);
        }
      }
    };
    const getFull = (id: string) =>
      untilDeadline((remaining) =>
        this.messages.get(address, id, {
          signal,
          maxRetries: 0,
          timeoutMs: Math.min(this.http.config.timeoutMs, Math.ceil(remaining)),
        }),
      );

    let after = options.after;
    // The message the loop skipped last and continues after; if it is deleted meanwhile, its time stands in.
    let skipped: SimpleMessage | null = null;

    for (;;) {
      const started = now();
      let message: SimpleMessage | null;
      try {
        message = await untilDeadline((remaining) => {
          const timeout = Math.min(MAX_SERVER_WAIT_S, Math.max(1, Math.ceil(remaining / 1000)));
          return waitOnce(
            this.http,
            address,
            { timeout, after, from: options.from, subject: options.subject },
            { signal, deadline, maxRetries: 0 },
          );
        });
      } catch (err) {
        const fallback = skipped !== null && after === skipped.id && isAfterNotFound(err) ? timeAfter(skipped) : null;
        if (fallback === null) throw err;
        after = fallback;
        skipped = null;
        continue;
      }
      if (message === null) {
        const pause = Math.min(EARLY_EMPTY_PAUSE_MS, deadline - now());
        if (now() - started < EARLY_EMPTY_PAUSE_MS && pause > 0) await sleep(pause, signal);
        continue;
      }
      // Continue strictly after this message whatever happens next: its id is exact, a time is not.
      after = message.id;
      skipped = message;
      if (options.match && !(await options.match(message))) continue;
      const value = await extract(message, getFull);
      if (value !== null) return value;
    }
  }
}

/** Worth waiting out inside the wait helpers: the server may well answer a moment later. */
function isTransient(err: unknown): boolean {
  if (err instanceof APIConnectionError || err instanceof RateLimitError) return true;
  return err instanceof APIError && (err.status === 503 || isGatewayStatus(err.status));
}

function isAfterNotFound(err: unknown): boolean {
  if (!(err instanceof NotFoundError)) return false;
  const body = err.body as { message?: unknown } | null;
  return typeof body === "object" && body !== null && body.message === AFTER_NOT_FOUND;
}

/** The skipped message's `createdAt` as RFC 3339 UTC with milliseconds; `null` if it is unreadable. */
function timeAfter(message: SimpleMessage): string | null {
  const t = Date.parse(message.createdAt);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function readEnv(name: string): string | undefined {
  // Typed loosely so the package needs no Node types and still loads where `process` does not exist.
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return proc?.env?.[name] || undefined;
}
