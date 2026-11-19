import { describe, expect, it } from "vitest";
import { APIConnectionError, APITimeoutError, InternalServerError, RateLimitError } from "../src/index.js";
import { apiError, empty, json, mailbox, setup } from "./helpers.js";

const busy = () => apiError(503, "internal_server_error", "service unavailable", { "Retry-After": "1" });
const limited = (s: string) => apiError(429, "rate_limit_exceeded", "rate limit exceeded", { "Retry-After": s });
const badGateway = () => new Response("bad gateway", { status: 502 });

describe("retries", () => {
  it("retries 429 honoring Retry-After", async () => {
    const { client, clock, requests } = setup([limited("7"), json({ domains: [] })]);
    await expect(client.domains.list()).resolves.toEqual([]);
    expect(requests).toHaveLength(2);
    expect(clock.sleeps).toEqual([7000]);
  });

  it("accepts Retry-After as an HTTP date", async () => {
    const at = new Date(1_800_000_000_000 + 3000).toUTCString(); // FakeClock starts at 1_800_000_000_000
    const { client, clock } = setup([limited(at), json({ domains: [] })]);
    await client.domains.list();
    expect(clock.sleeps).toEqual([3000]);
  });

  it("caps Retry-After at 60 s", async () => {
    const { client, clock } = setup([limited("3600"), json({ domains: [] })]);
    await client.domains.list();
    expect(clock.sleeps).toEqual([60_000]);
  });

  it("retries 429 and 503 on POST too (refused before any effect)", async () => {
    const { client, requests } = setup([limited("1"), busy(), json(mailbox, 201)]);
    await expect(client.mailboxes.create()).resolves.toEqual(mailbox);
    expect(requests.map((r) => r.method)).toEqual(["POST", "POST", "POST"]);
  });

  it("gives up after maxRetries and throws the last error", async () => {
    const { client, requests } = setup([limited("1"), limited("1"), limited("1")]);
    await expect(client.domains.list()).rejects.toBeInstanceOf(RateLimitError);
    expect(requests).toHaveLength(3);
  });

  it("respects a per-call maxRetries", async () => {
    const { client, requests } = setup([limited("1")]);
    await expect(client.domains.list({ maxRetries: 0 })).rejects.toBeInstanceOf(RateLimitError);
    expect(requests).toHaveLength(1);
  });

  it("does not retry POST on 502", async () => {
    const { client, requests } = setup([badGateway(), json(mailbox, 201)]);
    await expect(client.mailboxes.create()).rejects.toBeInstanceOf(InternalServerError);
    expect(requests).toHaveLength(1);
  });

  it("does not retry POST on a connection error", async () => {
    const { client, requests } = setup([new TypeError("fetch failed"), json(mailbox, 201)]);
    await expect(client.mailboxes.create()).rejects.toBeInstanceOf(APIConnectionError);
    expect(requests).toHaveLength(1);
  });

  it("retries GET on 502/504 with exponential backoff", async () => {
    const { client, clock } = setup(
      [badGateway(), new Response("", { status: 504 }), badGateway(), json({ domains: [] })],
      { maxRetries: 3 },
    );
    await client.domains.list();
    expect(clock.sleeps).toEqual([500, 1000, 2000]);
  });

  it("backoff is jittered downward and capped at 8 s", async () => {
    const replies = Array.from({ length: 7 }, badGateway);
    const { client, clock } = setup([...replies, json({ domains: [] })], { maxRetries: 7, random: () => 0.999 });
    await client.domains.list();
    expect(clock.sleeps.every((ms, i) => ms <= Math.min(500 * 2 ** i, 8000))).toBe(true);
    expect(clock.sleeps.at(-1)).toBeGreaterThanOrEqual(6000);
    expect(Math.max(...clock.sleeps)).toBeLessThanOrEqual(8000);
  });

  it("retries DELETE on a connection error", async () => {
    const { client, requests } = setup([new TypeError("fetch failed"), empty(204)]);
    await client.mailboxes.delete("a@example.org");
    expect(requests.map((r) => r.method)).toEqual(["DELETE", "DELETE"]);
  });

  it("does not retry 500 or 4xx", async () => {
    const { client, requests } = setup([apiError(500, "internal_server_error", "internal server error")]);
    await expect(client.domains.list()).rejects.toBeInstanceOf(InternalServerError);
    expect(requests).toHaveLength(1);
  });

  it("an HTTP attempt over timeoutMs is an APITimeoutError", async () => {
    const hang = (req: { signal: AbortSignal | undefined }) =>
      new Promise<Response>((_, reject) => {
        req.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    const { client } = setup([hang], { timeoutMs: 20, maxRetries: 0 });
    await expect(client.domains.list()).rejects.toBeInstanceOf(APITimeoutError);
  });

  it("an aborted signal rejects with its reason and is not retried", async () => {
    const controller = new AbortController();
    const reason = new Error("test over");
    const hang = (req: { signal: AbortSignal | undefined }) =>
      new Promise<Response>((_, reject) => {
        req.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        setTimeout(() => controller.abort(reason), 5);
      });
    const { client, requests } = setup([hang, json({ domains: [] })]);
    await expect(client.domains.list({ signal: controller.signal })).rejects.toBe(reason);
    expect(requests).toHaveLength(1);
  });
});
