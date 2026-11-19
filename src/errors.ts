import type { ErrorCode, RateLimitInfo } from "./types.js";

/** Base class of every error this SDK throws (an aborted call rejects with the signal's reason instead). */
export class FakeEmailError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

export interface APIErrorInit {
  status: number;
  headers: Headers;
  body: unknown;
}

/** The server answered with a non-2xx status. */
export class APIError extends FakeEmailError {
  /** HTTP status. */
  readonly status: number;
  /** The `error` field of the body (`ErrorCode`); `null` when the body is not the JSON envelope (e.g. a proxy's 502). */
  readonly code: ErrorCode | null;
  /** Parsed JSON body, or the raw text when it is not JSON, or `null` when empty. */
  readonly body: unknown;
  readonly headers: Headers;
  /** From `X-RateLimit-*`; `null` when the response did not carry them (the state is unknown, not zero). */
  readonly rateLimit: RateLimitInfo | null;

  constructor(init: APIErrorInit) {
    const envelope = asEnvelope(init.body);
    const phrase = envelope?.message ?? `HTTP ${init.status}`;
    super(envelope?.error ? `${init.status} ${envelope.error}: ${phrase}` : `${init.status}: ${phrase}`);
    this.status = init.status;
    this.code = (envelope?.error as ErrorCode | undefined) ?? null;
    this.body = init.body;
    this.headers = init.headers;
    this.rateLimit = parseRateLimit(init.headers);
  }
}

/** 400 `bad_request`: a parameter or the body is invalid. */
export class BadRequestError extends APIError {}

/** 401 `unauthorized`: the key is missing, unknown, revoked or expired. */
export class AuthenticationError extends APIError {}

/** 402 `quota_exhausted`: the monthly mailbox quota is spent. Not retried: it renews at `resetsAt`. */
export class QuotaExhaustedError extends APIError {
  readonly limit: number | null;
  readonly used: number | null;
  /** RFC 3339, the 1st of next month 00:00 UTC. */
  readonly resetsAt: string | null;
  readonly upgradeUrl: string | null;

  constructor(init: APIErrorInit) {
    super(init);
    const b = (isObject(init.body) ? init.body : {}) as Record<string, unknown>;
    this.limit = typeof b.limit === "number" ? b.limit : null;
    this.used = typeof b.used === "number" ? b.used : null;
    this.resetsAt = typeof b.resetsAt === "string" ? b.resetsAt : null;
    this.upgradeUrl = typeof b.upgradeUrl === "string" ? b.upgradeUrl : null;
  }
}

/** 403 `plan_forbidden`: the plan has no API access, or does not allow a custom `localPart`. */
export class PermissionDeniedError extends APIError {}

/** 404 `not_found`: the mailbox is not an active API mailbox of yours, or the message/attachment is not there. */
export class NotFoundError extends APIError {}

/** 409 `address_taken`: the address was issued before, to anyone. */
export class ConflictError extends APIError {}

/** 429: `code` is `rate_limit_exceeded` (requests per minute) or `too_many_waits` (concurrent waits). */
export class RateLimitError extends APIError {
  /** Seconds from `Retry-After`; `null` if absent. */
  readonly retryAfter: number | null;

  constructor(init: APIErrorInit) {
    super(init);
    const ms = parseRetryAfter(init.headers.get("retry-after"), Date.now());
    this.retryAfter = ms === null ? null : Math.ceil(ms / 1000);
  }
}

/** 5xx, including a proxy's 502 during a server restart and 503 `service unavailable`. */
export class InternalServerError extends APIError {}

/** The request did not get a response (DNS, refused connection, reset). */
export class APIConnectionError extends FakeEmailError {}

/** An HTTP attempt took longer than `timeoutMs`. */
export class APITimeoutError extends APIConnectionError {}

/** `waitForMessage` / `waitForCode` / `waitForLink` reached their deadline without a matching message. */
export class WaitTimeoutError extends FakeEmailError {
  readonly address: string;
  readonly timeoutMs: number;

  constructor(address: string, timeoutMs: number) {
    super(`no matching message in ${address} within ${timeoutMs} ms`);
    this.address = address;
    this.timeoutMs = timeoutMs;
  }
}

export function errorFromResponse(init: APIErrorInit): APIError {
  const s = init.status;
  if (s === 400) return new BadRequestError(init);
  if (s === 401) return new AuthenticationError(init);
  if (s === 402) return new QuotaExhaustedError(init);
  if (s === 403) return new PermissionDeniedError(init);
  if (s === 404) return new NotFoundError(init);
  if (s === 409) return new ConflictError(init);
  if (s === 429) return new RateLimitError(init);
  if (s >= 500) return new InternalServerError(init);
  return new APIError(init);
}

/** `Retry-After` in milliseconds from `now` (delta-seconds or an HTTP date); `null` if absent or unreadable. */
export function parseRetryAfter(value: string | null, now: number): number | null {
  if (value === null || value.trim() === "") return null;
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Number(v) * 1000;
  const date = Date.parse(v);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

function parseRateLimit(headers: Headers): RateLimitInfo | null {
  const limit = headers.get("x-ratelimit-limit");
  const remaining = headers.get("x-ratelimit-remaining");
  const reset = headers.get("x-ratelimit-reset");
  if (limit === null || remaining === null || reset === null) return null;
  const info = { limit: Number(limit), remaining: Number(remaining), reset: Number(reset) };
  return Object.values(info).every(Number.isFinite) ? info : null;
}

function asEnvelope(body: unknown): { error?: string; message?: string } | null {
  if (!isObject(body)) return null;
  const b = body as Record<string, unknown>;
  return {
    error: typeof b.error === "string" ? b.error : undefined,
    message: typeof b.message === "string" ? b.message : undefined,
  };
}

function isObject(v: unknown): v is object {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
