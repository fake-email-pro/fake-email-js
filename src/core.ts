import {
  APIConnectionError,
  APITimeoutError,
  errorFromResponse,
  parseRetryAfter,
  type APIError,
} from "./errors.js";
import type { RequestOptions } from "./types.js";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface HttpConfig {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  maxRetries: number;
  userAgent: string;
  fetch: FetchLike;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  now: () => number;
  random: () => number;
}

type Query = Record<string, string | number | undefined>;

export interface CallOptions extends RequestOptions {
  method: "GET" | "POST" | "DELETE";
  path: string;
  query?: Query;
  body?: unknown;
  /** Absolute time (config.now()) past which a retry is pointless: the caller has given up by then. */
  deadline?: number;
}

export interface RawResponse {
  status: number;
  headers: Headers;
  response: Response;
}

const MAX_RETRY_AFTER_MS = 60_000;
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 8_000;

export class HttpClient {
  constructor(readonly config: HttpConfig) {}

  async json<T>(opts: CallOptions): Promise<T> {
    const { response } = await this.send(opts);
    return (await response.json()) as T;
  }

  /** For `204` endpoints and `wait` (which answers `204` on timeout). */
  async jsonOrNull<T>(opts: CallOptions): Promise<T | null> {
    const { status, response } = await this.send(opts);
    if (status === 204) return null;
    const text = await response.text();
    return text === "" ? null : (JSON.parse(text) as T);
  }

  async send(opts: CallOptions): Promise<RawResponse> {
    const { config } = this;
    const maxRetries = opts.maxRetries ?? config.maxRetries;
    // DELETE is idempotent here too: a repeated delete is a 404 the caller can tolerate, never a second effect.
    const idempotent = opts.method !== "POST";
    const url = this.url(opts.path, opts.query);
    const init = this.init(opts);

    for (let attempt = 0; ; attempt++) {
      opts.signal?.throwIfAborted();
      let response: Response;
      try {
        response = await this.attempt(url, init, opts.timeoutMs ?? config.timeoutMs, opts.signal);
      } catch (err) {
        if (opts.signal?.aborted) throw opts.signal.reason;
        const delay = this.backoff(attempt);
        if (idempotent && attempt < maxRetries && this.fits(delay, opts.deadline)) {
          await config.sleep(delay, opts.signal);
          continue;
        }
        throw err;
      }

      if (response.ok) return { status: response.status, headers: response.headers, response };

      const error = await toError(response);
      const status = response.status;
      // 429 and 503 are refused before any effect, so even POST is safe to repeat; 502/504 may have
      // reached the handler, so only idempotent requests are repeated.
      const retryable = status === 429 || status === 503 || (idempotent && (status === 502 || status === 504));
      if (retryable && attempt < maxRetries) {
        const retryAfter = parseRetryAfter(response.headers.get("retry-after"), config.now());
        const delay = retryAfter === null ? this.backoff(attempt) : Math.min(retryAfter, MAX_RETRY_AFTER_MS);
        if (this.fits(delay, opts.deadline)) {
          await config.sleep(delay, opts.signal);
          continue;
        }
      }
      throw error;
    }
  }

  private async attempt(url: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal) {
    // AbortSignal.any/timeout are not in Node 18, so the two sources are joined by hand.
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      return await this.config.fetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      if (signal?.aborted) throw signal.reason;
      if (timedOut) throw new APITimeoutError(`request timed out after ${timeoutMs} ms`, { cause: err });
      throw new APIConnectionError(`connection error: ${describe(err)}`, { cause: err });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  private url(path: string, query?: Query): string {
    const url = new URL(this.config.baseUrl.replace(/\/+$/, "") + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    return url.toString();
  }

  private init(opts: CallOptions): RequestInit {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.apiKey}`,
      Accept: "application/json",
      "User-Agent": this.config.userAgent,
    };
    const init: RequestInit = { method: opts.method, headers };
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(opts.body);
    }
    return init;
  }

  private backoff(attempt: number): number {
    const base = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS);
    // Up to 25% jitter downwards, so parallel test workers do not retry in lockstep.
    return Math.round(base * (1 - 0.25 * this.config.random()));
  }

  private fits(delay: number, deadline?: number): boolean {
    return deadline === undefined || this.config.now() + delay < deadline;
  }
}

async function toError(response: Response): Promise<APIError> {
  let text = "";
  try {
    text = await response.text();
  } catch {
    // An unreadable body still maps by status.
  }
  let body: unknown = text === "" ? null : text;
  if (text !== "") {
    try {
      body = JSON.parse(text);
    } catch {
      // A proxy's HTML/plain error page: keep the text, map by status.
    }
  }
  return errorFromResponse({ status: response.status, headers: response.headers, body });
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    return cause instanceof Error ? `${err.message} (${cause.message})` : err.message;
  }
  return String(err);
}

/** setTimeout-based sleep that rejects with the signal's reason when aborted. */
export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Path segment for an address or id; `@` is encoded too, which the server accepts. */
export function seg(value: string): string {
  return encodeURIComponent(value);
}
