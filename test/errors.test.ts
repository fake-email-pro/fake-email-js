import { describe, expect, it } from "vitest";
import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  AuthenticationError,
  BadRequestError,
  ConflictError,
  FakeEmailError,
  InternalServerError,
  NotFoundError,
  PermissionDeniedError,
  QuotaExhaustedError,
  RateLimitError,
} from "../src/index.js";
import { apiError, json, setup } from "./helpers.js";

const RL = { "X-RateLimit-Limit": "60", "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "1792659660" };

async function failWith(reply: Response) {
  const { client } = setup([reply], { maxRetries: 0 });
  return client.mailboxes.create().catch((e: unknown) => e);
}

describe("error mapping", () => {
  it.each([
    [400, "bad_request", "invalid localPart", BadRequestError],
    [401, "unauthorized", "missing or invalid API key", AuthenticationError],
    [403, "plan_forbidden", "plan does not allow custom localPart", PermissionDeniedError],
    [404, "not_found", "domain not found", NotFoundError],
    [409, "address_taken", "address taken", ConflictError],
    [500, "internal_server_error", "internal server error", InternalServerError],
    [405, "method_not_allowed", "method not allowed", APIError],
    [413, "payload_too_large", "request body too large", APIError],
  ])("%i %s → %s", async (status, code, message, cls) => {
    const err = await failWith(apiError(status, code, message));
    expect(err).toBeInstanceOf(cls);
    expect(err).toBeInstanceOf(APIError);
    expect(err).toBeInstanceOf(FakeEmailError);
    expect(err).toBeInstanceOf(Error);
    const e = err as APIError;
    expect(e.status).toBe(status);
    expect(e.code).toBe(code);
    expect(e.message).toBe(`${status} ${code}: ${message}`);
    expect(e.body).toEqual({ error: code, message });
    expect(e.name).toBe(cls.name);
  });

  it("402 carries the quota fields", async () => {
    const err = await failWith(
      json(
        {
          error: "quota_exhausted",
          message: "monthly mailbox quota exhausted",
          limit: 20,
          used: 20,
          resetsAt: "2026-11-01T00:00:00.000Z",
          upgradeUrl: "https://fake-email.pro/pricing",
        },
        402,
        RL,
      ),
    );
    expect(err).toBeInstanceOf(QuotaExhaustedError);
    const e = err as QuotaExhaustedError;
    expect(e.code).toBe("quota_exhausted");
    expect(e.limit).toBe(20);
    expect(e.used).toBe(20);
    expect(e.resetsAt).toBe("2026-11-01T00:00:00.000Z");
    expect(e.upgradeUrl).toBe("https://fake-email.pro/pricing");
    expect(e.rateLimit).toEqual({ limit: 60, remaining: 0, reset: 1792659660 });
  });

  it("429 carries retryAfter and the code that tells the two cases apart", async () => {
    const err = (await failWith(
      apiError(429, "too_many_waits", "too many concurrent waits", { "Retry-After": "1", ...RL }),
    )) as RateLimitError;
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.code).toBe("too_many_waits");
    expect(err.retryAfter).toBe(1);
    expect(err.rateLimit).toEqual({ limit: 60, remaining: 0, reset: 1792659660 });
    expect(err.headers.get("retry-after")).toBe("1");
  });

  it("rateLimit is null without X-RateLimit-* (401, or the limiter was down)", async () => {
    const err = (await failWith(apiError(401, "unauthorized", "missing or invalid API key"))) as APIError;
    expect(err.rateLimit).toBeNull();
  });

  it("a non-JSON 502 from a proxy still maps by status", async () => {
    const { client } = setup([
      new Response("<html>502 Bad Gateway</html>", { status: 502, headers: { "Content-Type": "text/html" } }),
    ], { maxRetries: 0 });
    const err = (await client.domains.list().catch((e: unknown) => e)) as InternalServerError;
    expect(err).toBeInstanceOf(InternalServerError);
    expect(err.status).toBe(502);
    expect(err.code).toBeNull();
    expect(err.body).toBe("<html>502 Bad Gateway</html>");
    expect(err.message).toBe("502: HTTP 502");
  });

  it("an empty error body maps by status", async () => {
    const { client } = setup([new Response(null, { status: 404 })]);
    const err = (await client.domains.list().catch((e: unknown) => e)) as NotFoundError;
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.body).toBeNull();
  });

  it("a network failure is an APIConnectionError with the cause", async () => {
    const cause = new TypeError("fetch failed");
    const { client } = setup([cause], { maxRetries: 0 });
    const err = (await client.domains.list().catch((e: unknown) => e)) as APIConnectionError;
    expect(err).toBeInstanceOf(APIConnectionError);
    expect(err).not.toBeInstanceOf(APITimeoutError);
    expect(err.cause).toBe(cause);
  });
});
