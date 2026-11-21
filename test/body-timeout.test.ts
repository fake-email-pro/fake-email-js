import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { APITimeoutError, FakeEmail, InternalServerError } from "../src/index.js";
import { json, setup } from "./helpers.js";

const ADDR = "ci-runner-7@example.org";
const MID = "3c1b5f0e-6a8e-4b0e-9d3e-1f2a7c9b8e41";

/**
 * Headers arrive, then the body sends `prefix` and stalls forever. The stream ignores the request's abort
 * signal on purpose: the SDK must not rely on the fetch implementation to cut a stalled body.
 */
function stalled(status = 200, headers: Record<string, string> = { "Content-Type": "application/json" }, prefix = "{") {
  return () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(prefix));
        },
      }),
      { status, headers },
    );
}

describe("timeoutMs and the signal cover reading the body", () => {
  it("a JSON body that stalls after the headers is an APITimeoutError", async () => {
    const { client } = setup([stalled()], { timeoutMs: 30, maxRetries: 0 });
    await expect(client.limits.get()).rejects.toBeInstanceOf(APITimeoutError);
  });

  it("a GET whose body stalled is retried like any lost attempt", async () => {
    const { client, requests } = setup([stalled(), json({ domains: [] })], { timeoutMs: 30 });
    await expect(client.domains.list()).resolves.toEqual([]);
    expect(requests).toHaveLength(2);
  });

  it("raw: a stalled EML body is an APITimeoutError", async () => {
    const { client } = setup([stalled(200, { "Content-Type": "message/rfc822" }, "From: a")], {
      timeoutMs: 30,
      maxRetries: 0,
    });
    await expect(client.messages.raw(ADDR, MID)).rejects.toBeInstanceOf(APITimeoutError);
  });

  it("attachment: a stalled download is an APITimeoutError", async () => {
    const { client } = setup([stalled(200, { "Content-Type": "application/pdf" }, "%PDF")], {
      timeoutMs: 30,
      maxRetries: 0,
    });
    await expect(client.messages.attachment(ADDR, MID, "a1")).rejects.toBeInstanceOf(APITimeoutError);
  });

  it("an error response whose body stalls still maps by status", async () => {
    const { client } = setup([stalled(500)], { timeoutMs: 30, maxRetries: 0 });
    await expect(client.domains.list()).rejects.toBeInstanceOf(InternalServerError);
  });

  it("aborting the signal while the body is read rejects with its reason", async () => {
    const controller = new AbortController();
    const reason = new Error("test over");
    const { client, requests } = setup([stalled(), json({ domains: [] })], { timeoutMs: 60_000 });
    setTimeout(() => controller.abort(reason), 20);
    await expect(client.domains.list({ signal: controller.signal })).rejects.toBe(reason);
    expect(requests).toHaveLength(1);
  });
});

describe("against a real HTTP server that sends headers, then stalls", () => {
  let server: Server | undefined;

  afterEach(async () => {
    server?.closeAllConnections();
    await new Promise((resolve) => server?.close(resolve));
    server = undefined;
  });

  async function stallingServer(): Promise<string> {
    server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write('{"domains":'); // ...and never ends
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it("global fetch: timeoutMs cuts the stalled body", async () => {
    const client = new FakeEmail({ apiKey: "fep_test", baseUrl: await stallingServer(), timeoutMs: 200, maxRetries: 0 });
    const started = Date.now();
    await expect(client.domains.list()).rejects.toBeInstanceOf(APITimeoutError);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("global fetch: the caller's signal cuts the stalled body", async () => {
    const client = new FakeEmail({ apiKey: "fep_test", baseUrl: await stallingServer(), timeoutMs: 60_000 });
    const controller = new AbortController();
    const reason = new Error("test over");
    setTimeout(() => controller.abort(reason), 200);
    await expect(client.messages.raw(ADDR, MID, { signal: controller.signal })).rejects.toBe(reason);
  });
});
