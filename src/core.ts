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
  /** The whole body, read inside the attempt (its timeout and the caller's signal cover the body too). */
  body: Uint8Array;
}

const MAX_RETRY_AFTER_MS = 60_000;
// A 503 asking for a longer pause (an empty domain pool sends Retry-After: 60) is thrown at once: retrying it
// inside one call would only stall the caller.
const MAX_RETRIED_503_AFTER_MS = 5_000;
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 8_000;

export class HttpClient {
  constructor(readonly config: HttpConfig) {}

  async json<T>(opts: CallOptions): Promise<T> {
    const { body } = await this.send(opts);
    return JSON.parse(decode(body)) as T;
  }

  /** For `204` endpoints and `wait` (which answers `204` on timeout). */
  async jsonOrNull<T>(opts: CallOptions): Promise<T | null> {
    const { status, body } = await this.send(opts);
    if (status === 204) return null;
    const text = decode(body);
    return text === "" ? null : (JSON.parse(text) as T);
  }

  async send(opts: CallOptions): Promise<RawResponse> {
    const { config } = this;
    const maxRetries = opts.maxRetries ?? config.maxRetries;
    // DELETE is idempotent here too: a repeated delete is never a second effect.
    const idempotent = opts.method !== "POST";
    const url = this.url(opts.path, opts.query);
    const init = this.init(opts);
    // Set once an attempt was lost after it may have reached the handler (timeout, connection error, 502/504/52x).
    let mayHaveApplied = false;

    for (let attempt = 0; ; attempt++) {
      opts.signal?.throwIfAborted();
      let result: { response: Response; body: Uint8Array };
      try {
        result = await this.attempt(url, init, opts.timeoutMs ?? config.timeoutMs, opts.signal);
      } catch (err) {
        if (opts.signal?.aborted) throw opts.signal.reason;
        const delay = this.backoff(attempt);
        if (idempotent && attempt < maxRetries && this.fits(delay, opts.deadline)) {
          mayHaveApplied = true;
          await config.sleep(delay, opts.signal);
          continue;
        }
        throw err;
      }

      const { response, body } = result;
      const status = response.status;
      if (response.ok) return { status, headers: response.headers, body };
      // The lost attempt did delete it: the repeated DELETE finds nothing, which is the outcome asked for.
      if (status === 404 && opts.method === "DELETE" && mayHaveApplied) {
        return { status, headers: response.headers, body: new Uint8Array(0) };
      }

      const error = toError(response, body);
      const retryAfter = parseRetryAfter(response.headers.get("retry-after"), config.now());
      const lost = isGatewayStatus(status);
      // 429 and 503 are refused before any effect, so even POST is safe to repeat; 502/504/52x may have
      // reached the handler, so only idempotent requests are repeated.
      const retryable =
        status === 429 ||
        (status === 503 && (retryAfter === null || retryAfter <= MAX_RETRIED_503_AFTER_MS)) ||
        (idempotent && lost);
      if (retryable && attempt < maxRetries) {
        const delay = retryAfter === null ? this.backoff(attempt) : Math.min(retryAfter, MAX_RETRY_AFTER_MS);
        if (this.fits(delay, opts.deadline)) {
          if (lost) mayHaveApplied = true;
          await config.sleep(delay, opts.signal);
          continue;
        }
      }
      throw error;
    }
  }

  /**
   * One HTTP attempt, body included: `timeoutMs` and the caller's signal stay armed until the whole body is
   * read, so a response that stalls after its headers cannot hang the call.
   */
  private async attempt(
    url: string,
    init: RequestInit,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{ response: Response; body: Uint8Array }> {
    // AbortSignal.any/timeout are not in Node 18, so the two sources are joined by hand.
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    const failure = (err: unknown): unknown => {
      if (signal?.aborted) return signal.reason;
      if (timedOut) return new APITimeoutError(`request timed out after ${timeoutMs} ms`, { cause: err });
      return new APIConnectionError(`connection error: ${describe(err)}`, { cause: err });
    };
    try {
      let response: Response;
      try {
        // Raced against the signal as well, for a custom fetch that ignores it.
        response = await untilAborted(this.config.fetch(url, { ...init, signal: controller.signal }), controller.signal);
      } catch (err) {
        throw failure(err);
      }
      try {
        return { response, body: new Uint8Array(await untilAborted(response.arrayBuffer(), controller.signal)) };
      } catch (err) {
        discard(response);
        if (response.ok || signal?.aborted) throw failure(err);
        // An unreadable error body still maps by status.
        return { response, body: new Uint8Array(0) };
      }
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

/** 502, 504 and Cloudflare's 520–524: the request may or may not have reached the server. */
export function isGatewayStatus(status: number): boolean {
  return status === 502 || status === 504 || (status >= 520 && status <= 524);
}

function toError(response: Response, raw: Uint8Array): APIError {
  const text = decode(raw);
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

/** Best effort: frees a body whose reading was given up (a locked or non-web stream is left alone). */
function discard(response: Response): void {
  try {
    void response.body?.cancel().catch(() => {});
  } catch {
    // Not a web ReadableStream (a custom fetch): nothing to cancel here.
  }
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** `promise`, or a rejection with the signal's reason as soon as the signal aborts. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
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
