export { FakeEmail, DEFAULT_BASE_URL } from "./client.js";
export type { ClientOptions, WaitForMessageOptions } from "./client.js";
export { VERSION } from "./version.js";
export {
  FakeEmailError,
  APIError,
  BadRequestError,
  AuthenticationError,
  QuotaExhaustedError,
  PermissionDeniedError,
  NotFoundError,
  ConflictError,
  RateLimitError,
  InternalServerError,
  APIConnectionError,
  APITimeoutError,
  WaitTimeoutError,
} from "./errors.js";
export type { MailboxesResource } from "./resources/mailboxes.js";
export type { MessagesResource } from "./resources/messages.js";
export type { DomainsResource } from "./resources/domains.js";
export type { LimitsResource } from "./resources/limits.js";
export type { FetchLike } from "./core.js";
export type * from "./types.js";
