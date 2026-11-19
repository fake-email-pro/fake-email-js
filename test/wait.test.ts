import { describe, expect, it } from "vitest";
import { NotFoundError, RateLimitError, WaitTimeoutError, type SimpleMessage } from "../src/index.js";
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

  it("gives up on a 429 whose Retry-After passes the deadline", async () => {
    const { client, requests } = setup([apiError(429, "rate_limit_exceeded", "rate limit exceeded", { "Retry-After": "50" })]);
    await expect(client.waitForMessage(ADDR, { timeoutMs: 10_000 })).rejects.toBeInstanceOf(RateLimitError);
    expect(requests).toHaveLength(1);
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
