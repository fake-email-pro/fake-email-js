import { describe, expect, it, vi } from "vitest";
import { detailedMessage, empty, json, mailbox, page, setup, simpleMessage } from "./helpers.js";

const ADDR = "ci-runner-7@example.org";
const ENC = "ci-runner-7%40example.org";
const MID = "3c1b5f0e-6a8e-4b0e-9d3e-1f2a7c9b8e41";
const AID = "9a7e2c44-0d0b-4f7a-a1c1-2b9d5f3e6a10";

describe("mailboxes", () => {
  it("create sends POST /v1/mailboxes with the given fields", async () => {
    const { client, requests } = setup([json(mailbox, 201)]);
    const mb = await client.mailboxes.create({ localPart: "ci-runner-7", domain: "example.org" });
    expect(mb).toEqual(mailbox);
    expect(requests[0]!.method).toBe("POST");
    expect(requests[0]!.url.pathname).toBe("/v1/mailboxes");
    expect(requests[0]!.body).toEqual({ localPart: "ci-runner-7", domain: "example.org" });
    expect(requests[0]!.headers.get("content-type")).toBe("application/json");
  });

  it("create with no params sends an empty object", async () => {
    const { client, requests } = setup([json(mailbox, 201)]);
    await client.mailboxes.create();
    expect(requests[0]!.body).toEqual({});
  });

  it("list passes page and size, omits unset ones", async () => {
    const { client, requests } = setup([json(page([mailbox])), json(page([]))]);
    const res = await client.mailboxes.list({ page: 2, size: 10 });
    expect(res.content).toEqual([mailbox]);
    expect(requests[0]!.url.pathname).toBe("/v1/mailboxes");
    expect(requests[0]!.url.search).toBe("?page=2&size=10");
    await client.mailboxes.list();
    expect(requests[1]!.url.search).toBe("");
  });

  it("listAll walks every page", async () => {
    const a = { ...mailbox, address: "a@example.org" };
    const b = { ...mailbox, address: "b@example.org" };
    const c = { ...mailbox, address: "c@example.org" };
    const { client, requests } = setup([json(page([a, b], 0, 2)), json(page([c], 1, 2))]);
    const all = [];
    for await (const m of client.mailboxes.listAll()) all.push(m.address);
    expect(all).toEqual(["a@example.org", "b@example.org", "c@example.org"]);
    expect(requests.map((r) => r.url.search)).toEqual(["?page=0&size=50", "?page=1&size=50"]);
  });

  it("listAll stops on an empty first page", async () => {
    const { client, requests } = setup([json(page([], 0, 0))]);
    const all = [];
    for await (const m of client.mailboxes.listAll({ size: 5 })) all.push(m);
    expect(all).toEqual([]);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url.searchParams.get("size")).toBe("5");
  });

  it("get encodes the address", async () => {
    const { client, requests } = setup([json(mailbox)]);
    await client.mailboxes.get(ADDR);
    expect(requests[0]!.method).toBe("GET");
    expect(requests[0]!.url.pathname).toBe(`/v1/mailboxes/${ENC}`);
  });

  it("get encodes characters that would break the path", async () => {
    const { client, requests } = setup([json(mailbox)]);
    await client.mailboxes.get("a/b?c#d@example.org");
    expect(requests[0]!.url.pathname).toBe("/v1/mailboxes/a%2Fb%3Fc%23d%40example.org");
    expect(requests[0]!.url.search).toBe("");
  });

  it("delete sends DELETE and resolves on 204", async () => {
    const { client, requests } = setup([empty(204)]);
    await expect(client.mailboxes.delete(ADDR)).resolves.toBeUndefined();
    expect(requests[0]!.method).toBe("DELETE");
    expect(requests[0]!.url.pathname).toBe(`/v1/mailboxes/${ENC}`);
    expect(requests[0]!.body).toBeUndefined();
  });
});

describe("messages", () => {
  it("list", async () => {
    const msg = simpleMessage();
    const { client, requests } = setup([json(page([msg]))]);
    const res = await client.messages.list(ADDR, { page: 0, size: 5 });
    expect(res.content[0]).toEqual(msg);
    expect(requests[0]!.url.pathname).toBe(`/v1/mailboxes/${ENC}/messages`);
    expect(requests[0]!.url.search).toBe("?page=0&size=5");
  });

  it("listAll", async () => {
    const { client, requests } = setup([
      json(page([simpleMessage({ id: "1" })], 0, 2)),
      json(page([simpleMessage({ id: "2" })], 1, 2)),
    ]);
    const ids = [];
    for await (const m of client.messages.listAll(ADDR)) ids.push(m.id);
    expect(ids).toEqual(["1", "2"]);
    expect(requests[1]!.url.pathname).toBe(`/v1/mailboxes/${ENC}/messages`);
  });

  it("wait sends every filter and returns the message", async () => {
    const msg = simpleMessage();
    const { client, requests } = setup([json(msg)]);
    const res = await client.messages.wait(ADDR, { timeout: 45, after: MID, from: "acme", subject: "code" });
    expect(res).toEqual(msg);
    const r = requests[0]!;
    expect(r.method).toBe("GET");
    expect(r.url.pathname).toBe(`/v1/mailboxes/${ENC}/messages/wait`);
    expect(Object.fromEntries(r.url.searchParams)).toEqual({
      timeout: "45",
      after: MID,
      from: "acme",
      subject: "code",
    });
  });

  it("wait returns null on 204", async () => {
    const { client } = setup([empty(204)]);
    await expect(client.messages.wait(ADDR)).resolves.toBeNull();
  });

  it("wait turns a Date into ISO with milliseconds and encodes + offsets", async () => {
    const { client, requests } = setup([empty(204), empty(204)]);
    await client.messages.wait(ADDR, { after: new Date(Date.UTC(2026, 9, 22, 9, 0, 0, 5)) });
    expect(requests[0]!.url.searchParams.get("after")).toBe("2026-10-22T09:00:00.005Z");
    await client.messages.wait(ADDR, { after: "2026-10-22T12:00:00+03:00" });
    expect(requests[1]!.url.search).toContain("after=2026-10-22T12%3A00%3A00%2B03%3A00");
  });

  it("wait gives the HTTP attempt 10 s more than the server timeout", async () => {
    let seenTimeout = 0;
    const started: number[] = [];
    const { client } = setup([
      (req) =>
        new Promise<Response>((resolve, reject) => {
          started.push(Date.now());
          req.signal!.addEventListener("abort", () => {
            seenTimeout = Date.now() - started[0]!;
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    ], { maxRetries: 0 });
    // timeout: 1 → the attempt is cut at 11 s; fake timers avoid waiting for it.
    vi.useFakeTimers();
    try {
      const p = client.messages.wait(ADDR, { timeout: 1 });
      const assertion = expect(p).rejects.toMatchObject({ name: "APITimeoutError" });
      await vi.advanceTimersByTimeAsync(10_999);
      expect(seenTimeout).toBe(0);
      await vi.advanceTimersByTimeAsync(2);
      await assertion;
      expect(seenTimeout).toBeGreaterThanOrEqual(11_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("get returns the full message", async () => {
    const full = detailedMessage({ codes: ["123456"] });
    const { client, requests } = setup([json(full)]);
    await expect(client.messages.get(ADDR, MID)).resolves.toEqual(full);
    expect(requests[0]!.url.pathname).toBe(`/v1/mailboxes/${ENC}/messages/${MID}`);
  });

  it("delete", async () => {
    const { client, requests } = setup([empty(204)]);
    await client.messages.delete(ADDR, MID);
    expect(requests[0]!.method).toBe("DELETE");
    expect(requests[0]!.url.pathname).toBe(`/v1/mailboxes/${ENC}/messages/${MID}`);
  });

  it("raw returns the EML bytes", async () => {
    const eml = new TextEncoder().encode("Received: by fake-email\r\nSubject: hi\r\n\r\nbody");
    const { client, requests } = setup([
      new Response(eml, { status: 200, headers: { "Content-Type": "message/rfc822" } }),
    ]);
    const bytes = await client.messages.raw(ADDR, MID);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(bytes)).toContain("Subject: hi");
    expect(requests[0]!.url.pathname).toBe(`/v1/mailboxes/${ENC}/messages/${MID}/raw`);
  });

  it("attachment returns bytes, type and the RFC 5987 file name", async () => {
    const { client, requests } = setup([
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": "attachment; filename=\"Rechnung ?.pdf\"; filename*=UTF-8''Rechnung%20%E2%82%AC.pdf",
        },
      }),
    ]);
    const att = await client.messages.attachment(ADDR, MID, AID);
    expect(Array.from(att.data)).toEqual([1, 2, 3]);
    expect(att.contentType).toBe("application/pdf");
    expect(att.fileName).toBe("Rechnung €.pdf");
    expect(requests[0]!.url.pathname).toBe(`/v1/mailboxes/${ENC}/messages/${MID}/attachments/${AID}`);
  });
});

describe("domains and limits", () => {
  it("domains.list unwraps the list", async () => {
    const domains = [
      { name: "example.net", type: "PREMIUM" },
      { name: "example.org", type: "PUBLIC" },
    ];
    const { client, requests } = setup([json({ domains })]);
    await expect(client.domains.list()).resolves.toEqual(domains);
    expect(requests[0]!.url.pathname).toBe("/v1/domains");
  });

  it("limits.get", async () => {
    const limits = {
      quota: { limit: 20, used: 3, resetsAt: "2026-11-01T00:00:00.000Z" },
      requestsPerMinute: 60,
      concurrentWaits: 10,
      storage: { usedBytes: 18422, limitBytes: 52428800 },
      mailboxTtlSeconds: 86400,
    };
    const { client, requests } = setup([json(limits)]);
    await expect(client.limits.get()).resolves.toEqual(limits);
    expect(requests[0]!.method).toBe("GET");
    expect(requests[0]!.url.pathname).toBe("/v1/limits");
  });
});
