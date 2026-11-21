import { describe, expect, it, vi } from "vitest";
import {
  AuthenticationError,
  BadRequestError,
  NotFoundError,
  PermissionDeniedError,
  QuotaExhaustedError,
  WaitTimeoutError,
  type SimpleMessage,
} from "../src/index.js";
import {
  apiError,
  detailedMessage,
  empty,
  json,
  setup,
  simpleMessage,
  type FakeClock,
  type RecordedRequest,
} from "./helpers.js";

const ADDR = "ci-runner-7@example.org";

/** A wait reply that "holds" for the requested server timeout on the virtual clock, then answers 204. */
function hold(req: RecordedRequest, clock: FakeClock) {
  clock.advance(Number(req.url.searchParams.get("timeout") ?? 30) * 1000);
  return empty(204);
}

const q = (r: RecordedRequest) => Object.fromEntries(r.url.searchParams);

describe("waitForMessage", () => {
  it("returns the first message and passes the filters", async () => {
    const msg = simpleMessage();
    const { client, requests } = setup([json(msg)]);
    const res = await client.waitForMessage(ADDR, { from: "acme", subject: "code", timeoutMs: 30_000 });
    expect(res).toEqual(msg);
    expect(q(requests[0]!)).toEqual({ timeout: "30", from: "acme", subject: "code" });
  });

  it("loops on 204 with timeout = min(remaining, 60) s", async () => {
    const msg = simpleMessage();
    const { client, requests } = setup([hold, hold, json(msg)]);
    const res = await client.waitForMessage(ADDR, { timeoutMs: 150_000 });
    expect(res).toEqual(msg);
    expect(requests.map((r) => r.url.searchParams.get("timeout"))).toEqual(["60", "60", "30"]);
  });

  it("throws WaitTimeoutError at the deadline", async () => {
    const { client, requests } = setup([hold, hold]);
    const err = (await client.waitForMessage(ADDR, { timeoutMs: 90_500 }).catch((e: unknown) => e)) as WaitTimeoutError;
    expect(err).toBeInstanceOf(WaitTimeoutError);
    expect(err.address).toBe(ADDR);
    expect(err.timeoutMs).toBe(90_500);
    expect(requests.map((r) => r.url.searchParams.get("timeout"))).toEqual(["60", "31"]);
  });

  it("passes after (string or Date) on the first call", async () => {
    const { client, requests } = setup([json(simpleMessage()), json(simpleMessage())]);
    await client.waitForMessage(ADDR, { after: "3c1b5f0e-6a8e-4b0e-9d3e-1f2a7c9b8e41" });
    expect(requests[0]!.url.searchParams.get("after")).toBe("3c1b5f0e-6a8e-4b0e-9d3e-1f2a7c9b8e41");
    await client.waitForMessage(ADDR, { after: new Date("2026-10-22T09:00:00Z") });
    expect(requests[1]!.url.searchParams.get("after")).toBe("2026-10-22T09:00:00.000Z");
  });

  it("skips messages failing match and continues after them", async () => {
    const first = simpleMessage({ id: "m1", subject: "Welcome" });
    const second = simpleMessage({ id: "m2", subject: "Reset your password" });
    const { client, requests } = setup([json(first), json(second)]);
    const res = await client.waitForMessage(ADDR, {
      match: (m: SimpleMessage) => m.subject?.includes("password") ?? false,
    });
    expect(res.id).toBe("m2");
    expect(requests[0]!.url.searchParams.get("after")).toBeNull();
    expect(requests[1]!.url.searchParams.get("after")).toBe("m1");
  });

  it("accepts an async match", async () => {
    const { client } = setup([json(simpleMessage({ id: "m1" })), json(simpleMessage({ id: "m2" }))]);
    const res = await client.waitForMessage(ADDR, { match: async (m) => m.id === "m2" });
    expect(res.id).toBe("m2");
  });

  it("pauses instead of spinning when a 204 comes back early (server restart)", async () => {
    const { client, clock, requests } = setup([empty(204), json(simpleMessage())]);
    await client.waitForMessage(ADDR);
    expect(requests).toHaveLength(2);
    expect(clock.sleeps).toEqual([1000]);
  });

  it("waits out too_many_waits beyond maxRetries while the deadline allows", async () => {
    const tooMany = () => apiError(429, "too_many_waits", "too many concurrent waits", { "Retry-After": "1" });
    const { client, requests } = setup([tooMany(), tooMany(), tooMany(), tooMany(), json(simpleMessage())]);
    const res = await client.waitForMessage(ADDR);
    expect(res.id).toBe(simpleMessage().id);
    expect(requests).toHaveLength(5);
  });

  it("a 429 whose Retry-After passes the deadline sleeps to the deadline, then WaitTimeoutError", async () => {
    const { client, clock, requests } = setup([
      apiError(429, "rate_limit_exceeded", "rate limit exceeded", { "Retry-After": "50" }),
    ]);
    await expect(client.waitForMessage(ADDR, { timeoutMs: 10_000 })).rejects.toBeInstanceOf(WaitTimeoutError);
    expect(requests).toHaveLength(1);
    expect(clock.sleeps).toEqual([10_000]);
  });

  it("does not swallow a 404 (mailbox expired or deleted)", async () => {
    const { client } = setup([apiError(404, "not_found", "mailbox not found or expired")]);
    await expect(client.waitForMessage(ADDR)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("stops when the signal aborts", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled");
    const { client } = setup([
      () => {
        controller.abort(reason);
        return empty(204);
      },
      json(simpleMessage()),
    ]);
    await expect(client.waitForMessage(ADDR, { signal: controller.signal })).rejects.toBe(reason);
  });

  it("rejects at once with an already-aborted signal", async () => {
    const { client, requests } = setup([json(simpleMessage())]);
    await expect(client.waitForMessage(ADDR, { signal: AbortSignal.abort() })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(requests).toHaveLength(0);
  });
});

describe("wait helpers: transient errors and the deadline", () => {
  const gateway = (status: number) => () => new Response("", { status });

  it.each([502, 503, 504, 520, 521, 522, 523, 524])("waits out %i (1 s pause, no transport retries)", async (status) => {
    const { client, clock, requests } = setup([gateway(status), gateway(status), json(simpleMessage())]);
    await expect(client.waitForMessage(ADDR)).resolves.toEqual(simpleMessage());
    expect(requests).toHaveLength(3);
    expect(clock.sleeps).toEqual([1000, 2000]);
  });

  it("waits out a 503 with a long Retry-After, capped to the time left", async () => {
    const poolEmpty = apiError(503, "internal_server_error", "service unavailable", { "Retry-After": "60" });
    const { client, clock } = setup([poolEmpty, json(simpleMessage())]);
    await client.waitForMessage(ADDR, { timeoutMs: 120_000 });
    expect(clock.sleeps).toEqual([60_000]);
  });

  it("waits out a connection error", async () => {
    const { client, clock, requests } = setup([new TypeError("fetch failed"), json(simpleMessage())]);
    await expect(client.waitForMessage(ADDR)).resolves.toEqual(simpleMessage());
    expect(requests).toHaveLength(2);
    expect(clock.sleeps).toEqual([1000]);
  });

  it("waits out a per-attempt HTTP timeout (server timeout + 10 s)", async () => {
    vi.useFakeTimers();
    try {
      const hang = (req: RecordedRequest) =>
        new Promise<Response>((_, reject) => {
          req.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        });
      const { client, requests } = setup([hang, json(simpleMessage())]);
      const result = client.waitForMessage(ADDR, { timeoutMs: 20_000 });
      await vi.advanceTimersByTimeAsync(29_999);
      expect(requests).toHaveLength(1); // timeout=20 -> the attempt may run 30 s
      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toEqual(simpleMessage());
      expect(requests).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a persistent 502 ends in WaitTimeoutError, not an HTTP error", async () => {
    const replies = Array.from({ length: 40 }, () => gateway(502));
    const { client } = setup(replies);
    const err = await client.waitForMessage(ADDR, { timeoutMs: 10_000 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WaitTimeoutError);
  });

  it("no sleep and no request goes past the deadline", async () => {
    const replies = Array.from({ length: 40 }, () => gateway(502));
    const { client, clock } = setup(replies);
    const start = clock.t;
    await client.waitForMessage(ADDR, { timeoutMs: 10_000 }).catch(() => undefined);
    expect(clock.t - start).toBe(10_000);
  });

  it.each([
    [400, "bad_request", BadRequestError],
    [401, "unauthorized", AuthenticationError],
    [402, "quota_exhausted", QuotaExhaustedError],
    [403, "plan_forbidden", PermissionDeniedError],
  ] as const)("rethrows %i at once", async (status, code, cls) => {
    const { client, requests } = setup([apiError(status, code, "x"), json(simpleMessage())]);
    await expect(client.waitForMessage(ADDR)).rejects.toBeInstanceOf(cls);
    expect(requests).toHaveLength(1);
  });

  it("every wait request is sent without transport retries", async () => {
    // With transport retries a 502 would be repeated after a 500 ms backoff; the loop pauses 1 s instead.
    const { client, clock } = setup([gateway(502), json(simpleMessage())], { maxRetries: 5 });
    await client.waitForMessage(ADDR);
    expect(clock.sleeps).toEqual([1000]);
  });

  it("timeoutMs <= 0 throws WaitTimeoutError without a request", async () => {
    const { client, requests } = setup([json(simpleMessage())]);
    await expect(client.waitForMessage(ADDR, { timeoutMs: 0 })).rejects.toBeInstanceOf(WaitTimeoutError);
    await expect(client.waitForCode(ADDR, { timeoutMs: -5 })).rejects.toBeInstanceOf(WaitTimeoutError);
    expect(requests).toHaveLength(0);
  });

  it("a wait attempt is not cut by a short client timeoutMs (server timeout + 10 s)", async () => {
    const slow = (req: RecordedRequest) =>
      new Promise<Response>((resolve, reject) => {
        setTimeout(() => resolve(json(simpleMessage())), 60);
        req.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    const { client } = setup([slow, slow], { timeoutMs: 10, maxRetries: 0 });
    await expect(client.waitForMessage(ADDR)).resolves.toEqual(simpleMessage());
    // messages.wait: a shorter per-call timeoutMs cannot shorten the attempt either.
    await expect(client.messages.wait(ADDR, { timeout: 1 }, { timeoutMs: 10 })).resolves.toEqual(simpleMessage());
  });
});

describe("wait helpers: cursor after a skipped message that was deleted", () => {
  const afterGone = () => apiError(404, "not_found", "message in after not found");

  it("falls back to the skipped message's createdAt", async () => {
    const skipped = simpleMessage({ id: "m1", subject: "Welcome", createdAt: "2026-10-22T09:06:40.102Z" });
    const wanted = simpleMessage({ id: "m2", subject: "Reset" });
    const { client, requests } = setup([json(skipped), afterGone(), json(wanted)]);
    const res = await client.waitForMessage(ADDR, { match: (m) => m.subject === "Reset" });
    expect(res.id).toBe("m2");
    expect(requests.map((r) => r.url.searchParams.get("after"))).toEqual([null, "m1", "2026-10-22T09:06:40.102Z"]);
  });

  it("normalises the fallback time to UTC with milliseconds", async () => {
    const skipped = simpleMessage({ id: "m1", code: null, createdAt: "2026-10-22T12:06:40+03:00" });
    const { client, requests } = setup([
      json(skipped),
      json(detailedMessage({ id: "m1", codes: [] })),
      afterGone(),
      json(simpleMessage({ id: "m2", code: "123456" })),
    ]);
    await expect(client.waitForCode(ADDR)).resolves.toBe("123456");
    expect(requests[3]!.url.searchParams.get("after")).toBe("2026-10-22T09:06:40.000Z");
  });

  it("a caller's own after that is gone is still NotFoundError", async () => {
    const { client } = setup([afterGone()]);
    await expect(client.waitForMessage(ADDR, { after: "m0" })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("a 404 for the mailbox itself is still rethrown after a skip", async () => {
    const { client } = setup([
      json(simpleMessage({ id: "m1", subject: "Welcome" })),
      apiError(404, "not_found", "mailbox not found or expired"),
    ]);
    await expect(client.waitForMessage(ADDR, { match: () => false })).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("wait helpers: the full-message read respects the deadline", () => {
  it("waits out a transient error of messages.get without losing the message", async () => {
    const { client, clock, requests } = setup([
      json(simpleMessage({ id: "m1", code: null })),
      new Response("", { status: 502 }),
      json(detailedMessage({ id: "m1", codes: ["4242"] })),
    ]);
    await expect(client.waitForCode(ADDR)).resolves.toBe("4242");
    expect(requests.map((r) => r.url.pathname.split("/").at(-1))).toEqual(["wait", "m1", "m1"]);
    expect(clock.sleeps).toEqual([1000]);
  });

  it("ends in WaitTimeoutError when messages.get keeps failing past the deadline", async () => {
    const replies = Array.from({ length: 40 }, () => () => new Response("", { status: 503 }));
    const { client } = setup([json(simpleMessage({ id: "m1", confirmLink: null })), ...replies]);
    await expect(client.waitForLink(ADDR, { timeoutMs: 5_000 })).rejects.toBeInstanceOf(WaitTimeoutError);
  });

  it("the get's HTTP attempt is cut at the deadline", async () => {
    const hang = (req: RecordedRequest) =>
      new Promise<Response>((_, reject) => {
        req.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    const nearDeadline = (_req: RecordedRequest, clock: FakeClock) => {
      clock.advance(950); // the message arrives 50 ms before the deadline
      return json(simpleMessage({ id: "m1", code: null }));
    };
    const { client } = setup([nearDeadline, hang], { timeoutMs: 60_000 });
    const started = Date.now();
    await expect(client.waitForCode(ADDR, { timeoutMs: 1_000 })).rejects.toBeInstanceOf(WaitTimeoutError);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("a 404 of messages.get is rethrown", async () => {
    const { client } = setup([
      json(simpleMessage({ id: "m1", code: null })),
      apiError(404, "not_found", "message not found"),
    ]);
    await expect(client.waitForCode(ADDR)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("waitForCode", () => {
  it("returns the code computed on delivery", async () => {
    const { client, requests } = setup([json(simpleMessage({ code: "550712" }))]);
    await expect(client.waitForCode(ADDR)).resolves.toBe("550712");
    expect(requests).toHaveLength(1);
  });

  it("falls back to codes[0] of the full message", async () => {
    const msg = simpleMessage({ id: "m1", code: null });
    const { client, requests } = setup([json(msg), json(detailedMessage({ id: "m1", codes: ["9911", "1234"] }))]);
    await expect(client.waitForCode(ADDR)).resolves.toBe("9911");
    expect(requests[1]!.url.pathname).toBe(`/v1/mailboxes/ci-runner-7%40example.org/messages/m1`);
  });

  it("keeps waiting after a message without any code", async () => {
    const { client, requests } = setup([
      json(simpleMessage({ id: "m1", code: null })),
      json(detailedMessage({ id: "m1", codes: [] })),
      json(simpleMessage({ id: "m2", code: "777888" })),
    ]);
    await expect(client.waitForCode(ADDR, { subject: "code" })).resolves.toBe("777888");
    expect(q(requests[2]!)).toMatchObject({ after: "m1", subject: "code" });
  });

  it("applies match before extracting", async () => {
    const { client } = setup([
      json(simpleMessage({ id: "m1", code: "111111", from: { name: null, address: "a@other.example" } })),
      json(simpleMessage({ id: "m2", code: "222222" })),
    ]);
    const code = await client.waitForCode(ADDR, { match: (m) => m.from?.address === "no-reply@acme.example" });
    expect(code).toBe("222222");
  });
});

describe("waitForLink", () => {
  it("returns confirmLink", async () => {
    const { client } = setup([json(simpleMessage({ confirmLink: "https://acme.example/v?t=1" }))]);
    await expect(client.waitForLink(ADDR)).resolves.toBe("https://acme.example/v?t=1");
  });

  it("falls back to links[0].url, then keeps waiting", async () => {
    const { client } = setup([
      json(simpleMessage({ id: "m1", confirmLink: null })),
      json(detailedMessage({ id: "m1", links: [] })),
      json(simpleMessage({ id: "m2", confirmLink: null })),
      json(detailedMessage({ id: "m2", links: [{ url: "https://acme.example/magic", text: "Sign in" }] })),
    ]);
    await expect(client.waitForLink(ADDR)).resolves.toBe("https://acme.example/magic");
  });
});
