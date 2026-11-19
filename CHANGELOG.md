# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package uses [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-11-19

### Added

- `FakeEmail` client for the fake-email.pro Public API v1: `mailboxes` (create, list, listAll, get, delete),
  `messages` (list, listAll, wait, get, delete, raw, attachment), `domains.list`, `limits.get`.
- Test helpers `waitForMessage`, `waitForCode` and `waitForLink` with a client-side deadline, server-side `from` /
  `subject` filters, a `match` callback and `AbortSignal` support.
- Typed errors per status (`QuotaExhaustedError`, `RateLimitError`, ...) with `X-RateLimit-*` state.
- Retries on `429`/`503` honoring `Retry-After`, and on `502`/`504`/network errors for `GET` and `DELETE`.
- Types generated from the OpenAPI spec; ESM and CommonJS builds; zero runtime dependencies.

[0.1.0]: https://github.com/fake-email-pro/fake-email-js/releases/tag/v0.1.0
