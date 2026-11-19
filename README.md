# fake-email-pro

[![npm](https://img.shields.io/npm/v/fake-email-pro.svg)](https://www.npmjs.com/package/fake-email-pro)
[![CI](https://github.com/fake-email-pro/fake-email-js/actions/workflows/ci.yml/badge.svg)](https://github.com/fake-email-pro/fake-email-js/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/fake-email-pro.svg)](LICENSE)

The official TypeScript/JavaScript client for the [fake-email.pro API](https://fake-email.pro/api): create a
disposable mailbox, wait for the email, get the one-time code or the magic link. Built for end-to-end tests of
signup, OTP and password-reset flows in Playwright, Cypress, Vitest and Jest.

```ts
const { address } = await mail.mailboxes.create();
// ...sign up with `address` in your app...
const code = await mail.waitForCode(address); // "048213"
```

- Zero dependencies, native `fetch`, Node.js 18+
- ESM and CommonJS, full TypeScript types generated from the [OpenAPI spec](openapi/public.yaml)
- Long-poll waiting: the message is returned within about a second of delivery, no polling loops in your tests
- Codes and confirm links are extracted on the server
- Retries on rate limits and transient errors, honoring `Retry-After`

API reference: [api.fake-email.pro/docs](https://api.fake-email.pro/docs) · Guides:
[fake-email.pro/api/docs/sdks](https://fake-email.pro/api/docs/sdks)

## Install

```sh
npm install --save-dev fake-email-pro
```

## Get an API key

1. Sign in at [fake-email.pro](https://fake-email.pro). Any account can use the API, the free plan included.
2. Open **Settings → API keys** ([fake-email.pro/settings/api-keys](https://fake-email.pro/settings/api-keys)) and
   create a key. It starts with `fep_` and is shown only once.
3. Put it in the environment of your test runner (and in your CI secrets):

```sh
export FAKE_EMAIL_API_KEY=fep_...
```

The client reads `FAKE_EMAIL_API_KEY` by default. A bigger monthly quota and higher limits come with
[PRO](https://fake-email.pro/pricing).

> **Server-side only.** Never use the key in browser JavaScript: anyone visiting the page could read it, and the
> API does not allow cross-origin requests (no CORS). In browser test runners like Cypress, call the SDK from the
> Node side (see [Cypress](#cypress)).

## Quickstart

```ts
import { FakeEmail } from "fake-email-pro";

const mail = new FakeEmail(); // or new FakeEmail({ apiKey: "fep_..." })

// 1. A fresh address, valid for 24 hours
const { address } = await mail.mailboxes.create();

// 2. Make your app send an email to it
await fetch("https://your-app.example/api/signup", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: address }),
});

// 3. Wait for the email and take the code
const code = await mail.waitForCode(address, { timeoutMs: 60_000 });

// Or the confirm / magic link
// const link = await mail.waitForLink(address);

await mail.mailboxes.delete(address);
```

`waitForCode` returns the code found in the email when it was delivered. If none was found then, it reads the
full message and takes its first code; an email with no code at all is skipped and the wait goes on.
`waitForLink` does the same with the confirm link.

## Playwright

```ts
// tests/signup.spec.ts
import { test as base, expect } from "@playwright/test";
import { FakeEmail } from "fake-email-pro";

const mail = new FakeEmail();

// A fresh mailbox per test, deleted afterwards
const test = base.extend<{ inbox: string }>({
  inbox: async ({}, use) => {
    const { address } = await mail.mailboxes.create();
    await use(address);
    await mail.mailboxes.delete(address);
  },
});

test("sign up with an email code", async ({ page, inbox }) => {
  await page.goto("/signup");
  await page.getByLabel("Email").fill(inbox);
  await page.getByRole("button", { name: "Send code" }).click();

  const code = await mail.waitForCode(inbox, { subject: "verification" });

  await page.getByLabel("Code").fill(code);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("Welcome")).toBeVisible();
});
```

Playwright tests run in Node, so the SDK is called directly. Keep the test timeout above `timeoutMs` of the wait
(Playwright's default is 30 s; `waitForCode` defaults to 60 s).

## Cypress

Cypress test code runs in the browser, where the key must not go. Register tasks in the config, which runs in
Node, and call them with `cy.task`:

```ts
// cypress.config.ts
import { defineConfig } from "cypress";
import { FakeEmail } from "fake-email-pro";

const mail = new FakeEmail(); // FAKE_EMAIL_API_KEY from the environment of `cypress run`

export default defineConfig({
  e2e: {
    setupNodeEvents(on) {
      on("task", {
        createMailbox: async () => (await mail.mailboxes.create()).address,
        waitForCode: ({ address, subject }: { address: string; subject?: string }) =>
          mail.waitForCode(address, { subject, timeoutMs: 60_000 }),
        waitForLink: ({ address }: { address: string }) => mail.waitForLink(address, { timeoutMs: 60_000 }),
        deleteMailbox: async (address: string) => {
          await mail.mailboxes.delete(address);
          return null; // a task must not return undefined
        },
      });
    },
  },
});
```

```ts
// cypress/e2e/signup.cy.ts
it("signs up with an email code", () => {
  cy.task<string>("createMailbox").then((address) => {
    cy.visit("/signup");
    cy.get("input[name=email]").type(address);
    cy.contains("button", "Send code").click();

    // Above the wait's own timeoutMs; Cypress' default taskTimeout is 60 s
    cy.task<string>("waitForCode", { address }, { timeout: 90_000 }).then((code) => {
      cy.get("input[name=code]").type(code);
    });
    cy.contains("Welcome");
    cy.task("deleteMailbox", address);
  });
});
```

## Waiting for messages

```ts
const message = await mail.waitForMessage(address, {
  timeoutMs: 60_000, // client-side deadline, then WaitTimeoutError
  from: "acme.example", // case-insensitive substring of the sender address
  subject: "verify", // case-insensitive substring of the subject
  match: (m) => m.attachmentsCount > 0, // any extra check, may be async
});
message.code; // "048213" or null
message.confirmLink; // "https://..." or null
```

`from` and `subject` are filtered on the server. A message that fails `match` is skipped and the wait continues
with the next one. Under the hood the client repeats the server's long poll (up to 60 s each) until the deadline.

### The next message

Without `after`, the wait returns the **earliest** message in the mailbox, even one that arrived before you
started waiting, so nothing is lost. To wait for a newer one, for example after "Resend code", pass the previous
message's id:

```ts
const first = await mail.waitForMessage(address);
await page.getByRole("button", { name: "Resend code" }).click();
const second = await mail.waitForMessage(address, { after: first.id });
```

`after` also takes a time (`Date` or an RFC 3339 string): "messages that arrived after this moment" by the
server's clock. Prefer a message id: it is exact, while a time depends on clock skew. Do not pass a message's
`createdAt` as `after`: a second message in the same millisecond would be skipped.

An `after` id that is no longer in the mailbox (you deleted that message) is a `NotFoundError`: if your tests
delete processed messages, wait without `after`.

### Cancelling

Every method takes an `AbortSignal`; the helpers take it as `signal`, the other methods in their last argument:

```ts
const controller = new AbortController();
const code = await mail.waitForCode(address, { signal: controller.signal });
await mail.mailboxes.list({}, { signal: controller.signal });
```

An aborted call rejects with the signal's reason (an `AbortError` by default).

## Messages, attachments and raw EML

```ts
const page = await mail.messages.list(address, { page: 0, size: 20 }); // newest first
for await (const m of mail.messages.listAll(address)) console.log(m.subject);

const full = await mail.messages.get(address, message.id);
full.html; full.text; full.codes; full.links; full.attachments;

const { data, contentType, fileName } = await mail.messages.attachment(address, message.id, full.attachments[0]!.id);
// data: Uint8Array, e.g. await fs.writeFile(fileName ?? "attachment.bin", data)

const eml = await mail.messages.raw(address, message.id); // Uint8Array, the message as received

await mail.messages.delete(address, message.id);
```

One long poll without the client-side loop: `mail.messages.wait(address, { timeout: 30, after, from, subject })`
returns the message or `null` when the server timeout passed.

## Mailboxes, domains and limits

```ts
await mail.mailboxes.create(); // random address on a random domain
await mail.mailboxes.create({ domain: "example.org" }); // random address on that domain
await mail.mailboxes.create({ localPart: "signup-test", domain: "example.org" }); // exactly that address

await mail.mailboxes.get(address);
await mail.mailboxes.list({ page: 0, size: 50 });
for await (const mb of mail.mailboxes.listAll()) console.log(mb.address);
await mail.mailboxes.delete(address); // messages are erased; the address is never issued again

const domains = await mail.domains.list(); // [{ name: "example.org", type: "PUBLIC" }, ...]
const limits = await mail.limits.get(); // quota, requestsPerMinute, concurrentWaits, storage, mailboxTtlSeconds
```

A mailbox accepts mail for 24 hours and cannot be renewed; after that it answers `404`. Each created mailbox
spends one unit of your monthly quota (deleting it does not give it back). Custom local parts depend on the plan.

## Errors

All errors extend `FakeEmailError`. Errors from the server are `APIError` with `status`, `code` (the API's
`error` field), `message`, `body`, `headers` and `rateLimit`:

| Class                   | When                                                                         |
| ----------------------- | ---------------------------------------------------------------------------- |
| `BadRequestError`       | 400 `bad_request`: an invalid parameter or body                              |
| `AuthenticationError`   | 401 `unauthorized`: missing, unknown, revoked or expired key                 |
| `QuotaExhaustedError`   | 402 `quota_exhausted`: monthly mailbox quota spent (`limit`, `used`, `resetsAt`, `upgradeUrl`) |
| `PermissionDeniedError` | 403 `plan_forbidden`: the plan does not allow this                           |
| `NotFoundError`         | 404 `not_found`: mailbox expired, deleted or not yours; no such message     |
| `ConflictError`         | 409 `address_taken`: the address was issued before                           |
| `RateLimitError`        | 429: `code` is `rate_limit_exceeded` or `too_many_waits`; `retryAfter` in s  |
| `InternalServerError`   | 5xx                                                                          |
| `APIConnectionError`    | no response (DNS, refused, reset)                                            |
| `APITimeoutError`       | an HTTP attempt took longer than `timeoutMs`                                 |
| `WaitTimeoutError`      | `waitForMessage` / `waitForCode` / `waitForLink` reached their deadline      |

```ts
import { FakeEmail, QuotaExhaustedError, WaitTimeoutError } from "fake-email-pro";

try {
  const { address } = await mail.mailboxes.create();
} catch (err) {
  if (err instanceof QuotaExhaustedError) {
    console.error(`Quota ${err.used}/${err.limit}, renews ${err.resetsAt}. More: ${err.upgradeUrl}`);
  }
  throw err;
}
```

### Retries and rate limits

The client retries up to `maxRetries` times (default 2):

- `429` and `503`, for every method: the server refuses these before doing anything. The wait is `Retry-After`
  (at most 60 s).
- `502`, `504`, timeouts and network errors, for `GET` and `DELETE` only, never for `POST` (a mailbox could be
  created twice). Exponential backoff with jitter: 0.5 s, 1 s, 2 s, ... up to 8 s.

Inside `waitForMessage` and friends, a `429` keeps being waited out while the deadline allows, and no retry is
started that would end past the deadline.

Your plan's numbers are in `mail.limits.get()`. Every error carries the window state from the
`X-RateLimit-*` headers as `err.rateLimit` (`{ limit, remaining, reset }`, or `null` when the server did not send
them). Each `wait` request counts once, however long it is held open.

## Configuration

```ts
const mail = new FakeEmail({
  apiKey: "fep_...", // default: process.env.FAKE_EMAIL_API_KEY
  baseUrl: "https://api.fake-email.pro", // default
  timeoutMs: 30_000, // per HTTP attempt; a wait request gets its server timeout + 10 s
  maxRetries: 2,
  fetch: customFetch, // default: the global fetch
  userAgent: "my-e2e-suite/1.0", // appended to "fake-email-pro-js/<version>"
});
```

Every method also takes per-call options as its last argument: `{ signal, timeoutMs, maxRetries }`.

Types for every object are exported: `Mailbox`, `SimpleMessage`, `DetailedMessage`, `Attachment`, `Link`,
`Sender`, `Domain`, `Limits`, `Quota`, `ErrorCode` and more, as well as the raw generated `paths`, `components`
and `operations`.

## Links

- Product: [fake-email.pro/api](https://fake-email.pro/api)
- API reference: [api.fake-email.pro/docs](https://api.fake-email.pro/docs) (OpenAPI:
  [public.yaml](https://api.fake-email.pro/docs/public.yaml))
- SDK docs: [fake-email.pro/api/docs/sdks](https://fake-email.pro/api/docs/sdks)
- Issues: [github.com/fake-email-pro/fake-email-js/issues](https://github.com/fake-email-pro/fake-email-js/issues)
- Changelog: [CHANGELOG.md](CHANGELOG.md)

## License

[MIT](LICENSE)
