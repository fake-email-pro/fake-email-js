// Friendly names for the schemas in the generated file; the generated file is never edited by hand.
import type { components } from "./generated/public.js";

type Schemas = components["schemas"];

export type Mailbox = Schemas["Mailbox"];
export type MailboxPage = Schemas["MailboxPage"];
export type SimpleMessage = Schemas["SimpleMessage"];
export type MessagePage = Schemas["MessagePage"];
export type DetailedMessage = Schemas["DetailedMessage"];
export type Attachment = Schemas["Attachment"];
export type Link = Schemas["Link"];
export type Sender = Schemas["From"];
export type BodyState = Schemas["BodyState"];
export type Domain = Schemas["Domain"];
export type DomainType = Schemas["DomainType"];
export type Limits = Schemas["Limits"];
export type Quota = Schemas["Quota"];
export type Storage = Schemas["Storage"];
export type ErrorCode = Schemas["ErrorCode"];
/** The error envelope: `{ error, message }`. */
export type ErrorBody = Schemas["Error"];
/** Body of `402 quota_exhausted`. */
export type QuotaExhaustedBody = Schemas["QuotaExhaustedError"];

export type { components, operations, paths } from "./generated/public.js";

/** Per-call options accepted by every method as the last argument. */
export interface RequestOptions {
  /** Cancels the call; the promise rejects with the signal's reason. */
  signal?: AbortSignal;
  /** Overrides the client's `timeoutMs` for each HTTP attempt of this call. */
  timeoutMs?: number;
  /** Overrides the client's `maxRetries` for this call. */
  maxRetries?: number;
}

export interface CreateMailboxParams {
  /** Exact local part; requires `domain` and a plan that allows custom local parts. */
  localPart?: string;
  /** A domain from `domains.list()`; random if omitted. */
  domain?: string;
}

export interface PageParams {
  /** Zero-based page number. */
  page?: number;
  /** Page size, 1..50 (server default 20). */
  size?: number;
}

export interface ListAllParams {
  /** Page size used while iterating, 1..50 (default 50). */
  size?: number;
}

export interface WaitParams {
  /** Server-side wait in seconds, 1..60 (server default 30). */
  timeout?: number;
  /**
   * Only messages strictly after this: a message id (to continue after a message you got) or a time
   * (RFC 3339 string or `Date`, by the server's clock). Do not pass a message's `createdAt`.
   */
  after?: string | Date;
  /** Case-insensitive substring of the sender address. */
  from?: string;
  /** Case-insensitive substring of the subject. */
  subject?: string;
}

export interface DownloadedAttachment {
  data: Uint8Array;
  contentType: string;
  /** From `Content-Disposition` (RFC 5987 `filename*` preferred); `null` if absent. */
  fileName: string | null;
}

export interface RateLimitInfo {
  /** Requests per minute on the plan. */
  limit: number;
  /** Requests left in the current window. */
  remaining: number;
  /** End of the window, Unix seconds. */
  reset: number;
}
