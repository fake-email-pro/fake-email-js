import { defaultSleep, HttpClient, type FetchLike } from "./core.js";
import { FakeEmailError, RateLimitError, WaitTimeoutError } from "./errors.js";
import { DomainsResource } from "./resources/domains.js";
import { LimitsResource } from "./resources/limits.js";
import { MailboxesResource } from "./resources/mailboxes.js";
import { MessagesResource, waitOnce } from "./resources/messages.js";
import type { SimpleMessage } from "./types.js";
import { VERSION } from "./version.js";

export const DEFAULT_BASE_URL = "https://api.fake-email.pro";

export interface ClientOptions {
  /** API key (`fep_…`). Defaults to the `FAKE_EMAIL_API_KEY` environment variable. */
  apiKey?: string;
  /** Default `https://api.fake-email.pro`. */
  baseUrl?: string;
  /** Per HTTP attempt, in ms (default 30 000). A `wait` request gets its server timeout + 10 s instead. */
  timeoutMs?: number;
  /** Retries on 429/503, and on 502/504/network errors for GET and DELETE (default 2). */
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
  /** Client-side deadline for the whole wait, in ms (default 60 000). */
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
   * Throws `WaitTimeoutError` at the deadline.
   */
  waitForMessage(address: string, options: WaitForMessageOptions = {}): Promise<SimpleMessage> {
    return this.waitLoop(address, options, async (m) => m);
  }

  /**
   * Waits for a message with a one-time code and returns the code. Uses the code found on delivery, else
   * the first code of the full message; a message without any code is skipped.
   */
  waitForCode(address: string, options: WaitForMessageOptions = {}): Promise<string> {
    return this.waitLoop(address, options, async (m) => {
      if (m.code) return m.code;
      const full = await this.messages.get(address, m.id, { signal: options.signal });
      return full.codes[0] ?? null;
    });
  }

  /**
   * Waits for a message with a confirm / sign-in link and returns its URL. Uses the link found on delivery,
   * else the first link of the full message; a message without links is skipped.
   */
  waitForLink(address: string, options: WaitForMessageOptions = {}): Promise<string> {
    return this.waitLoop(address, options, async (m) => {
      if (m.confirmLink) return m.confirmLink;
      const full = await this.messages.get(address, m.id, { signal: options.signal });
      return full.links[0]?.url ?? null;
    });
  }

  private async waitLoop<T>(
    address: string,
    options: WaitForMessageOptions,
    extract: (message: SimpleMessage) => Promise<T | null>,
  ): Promise<T> {
    const { now, sleep } = this.http.config;
    const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_FOR_MS;
    const deadline = now() + timeoutMs;
    const { signal } = options;
    let after = options.after;

    for (;;) {
      signal?.throwIfAborted();
      const remaining = deadline - now();
      if (remaining <= 0) throw new WaitTimeoutError(address, timeoutMs);
      const timeout = Math.min(MAX_SERVER_WAIT_S, Math.max(1, Math.ceil(remaining / 1000)));
      const started = now();
      let message: SimpleMessage | null;
      try {
        message = await waitOnce(
          this.http,
          address,
          { timeout, after, from: options.from, subject: options.subject },
          { signal, deadline },
        );
      } catch (err) {
        // The request already used its retries; a 429 (usually too_many_waits) is still worth waiting out
        // while the caller's deadline allows.
        const pause = err instanceof RateLimitError ? (err.retryAfter ?? 1) * 1000 : null;
        if (pause !== null && now() + pause < deadline) {
          await sleep(pause, signal);
          continue;
        }
        throw err;
      }
      if (message === null) {
        const pause = Math.min(EARLY_EMPTY_PAUSE_MS, deadline - now());
        if (now() - started < EARLY_EMPTY_PAUSE_MS && pause > 0) await sleep(pause, signal);
        continue;
      }
      // Continue strictly after this message whatever happens next: its id is exact, a time is not.
      after = message.id;
      if (options.match && !(await options.match(message))) continue;
      const value = await extract(message);
      if (value !== null) return value;
    }
  }
}

function readEnv(name: string): string | undefined {
  // Typed loosely so the package needs no Node types and still loads where `process` does not exist.
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return proc?.env?.[name] || undefined;
}
