# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package uses [Semantic Versioning](https://semver.org/).

## [0.2.0] - 2026-11-22

### Fixed

- `timeoutMs` and the `AbortSignal` now cover reading the response body too (JSON, `messages.raw`,
  `messages.attachment`, error bodies): a response that stalls after its headers no longer hangs the call. A `GET`
  or `DELETE` whose body stalled is retried like any other lost attempt.
- `waitForMessage` / `waitForCode` / `waitForLink` wait out every transient error until their deadline, not only
  `429`: `502`, `503`, `504`, Cloudflare `520`–`524`, timeouts and network errors (`Retry-After` if sent, else
  1 s, 2 s, 4 s). At the deadline they throw `WaitTimeoutError`, never the HTTP error. Their wait requests are sent
  without transport retries (the loop owns them), and the full-message read of `waitForCode` / `waitForLink`
  respects the same deadline.
- The helpers no longer fail with `NotFoundError` when a message they skipped is deleted meanwhile: they continue
  after its `createdAt`. A missing `after` id you pass yourself is still a `NotFoundError`.
- `messages.wait`: a per-call `timeoutMs` can no longer cut the HTTP attempt below the server timeout + 10 s.
- `mailboxes.delete` / `messages.delete`: a `404` on a retry after a lost response (timeout, network error,
  `502`/`504`/`52x`) is success; a `404` on the first attempt is still a `NotFoundError`.
- `GET` and `DELETE` are retried on Cloudflare `520`–`524` as on `502`/`504`.
- A `503` with `Retry-After` over 5 s (e.g. no domain available on `mailboxes.create`, `Retry-After: 60`) is thrown
  at once instead of stalling the call for a minute.
- Docs: `DownloadedAttachment.fileName` is never `null` from the API (it is the attachment id when the email gave no
  name) and is sender-controlled; the README strips directories before saving it. `NotFoundError` also covers an
  unknown `domain` on create and a missing `after` message; the server lowercases a custom local part. The
  Playwright example passes a `timeoutMs` below Playwright's 30 s test timeout.

## [0.1.0] - 2026-11-19

### Added

- `FakeEmail` client for the fake-email.pro Public API v1: `mailboxes` (create, list, listAll, get, delete),
  `messages` (list, listAll, wait, get, delete, raw, attachment), `domains.list`, `limits.get`.
- Test helpers `waitForMessage`, `waitForCode` and `waitForLink` with a client-side deadline, server-side `from` /
  `subject` filters, a `match` callback and `AbortSignal` support.
- Typed errors per status (`QuotaExhaustedError`, `RateLimitError`, ...) with `X-RateLimit-*` state.
- Retries on `429`/`503` honoring `Retry-After`, and on `502`/`504`/network errors for `GET` and `DELETE`.
- Types generated from the OpenAPI spec; ESM and CommonJS builds; zero runtime dependencies.

[0.2.0]: https://github.com/fake-email-pro/fake-email-js/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/fake-email-pro/fake-email-js/releases/tag/v0.1.0
