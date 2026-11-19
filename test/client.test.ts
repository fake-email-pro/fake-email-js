import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeEmail, FakeEmailError, VERSION } from "../src/index.js";
import pkg from "../package.json" with { type: "json" };
import { json, mailbox, setup } from "./helpers.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("construction", () => {
  it("reads the key from FAKE_EMAIL_API_KEY", async () => {
    vi.stubEnv("FAKE_EMAIL_API_KEY", "fep_from_env");
    const fetch = vi.fn(async (_input: string, _init: RequestInit) => json(mailbox));
    const client = new FakeEmail({ fetch });
    await client.mailboxes.get("a@example.org");
    const init = fetch.mock.calls[0]![1];
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer fep_from_env");
  });

  it("prefers an explicit key over the environment", async () => {
    vi.stubEnv("FAKE_EMAIL_API_KEY", "fep_from_env");
    const { client, requests } = setup([json(mailbox)], { apiKey: "fep_explicit" });
    await client.mailboxes.get("a@example.org");
    expect(requests[0]!.headers.get("authorization")).toBe("Bearer fep_explicit");
  });

  it("throws without a key", () => {
    vi.stubEnv("FAKE_EMAIL_API_KEY", "");
    expect(() => new FakeEmail()).toThrow(FakeEmailError);
    expect(() => new FakeEmail()).toThrow(/FAKE_EMAIL_API_KEY/);
  });

  it("works where process does not exist", () => {
    vi.stubGlobal("process", undefined);
    expect(() => new FakeEmail()).toThrow(/missing API key/);
    expect(() => new FakeEmail({ apiKey: "fep_x" })).not.toThrow();
  });

  it("defaults to the production base URL and the global fetch", async () => {
    const fetch = vi.fn(async (_input: string, _init: RequestInit) => json(mailbox));
    vi.stubGlobal("fetch", fetch);
    const client = new FakeEmail({ apiKey: "fep_x" });
    await client.mailboxes.get("a@example.org");
    expect(fetch.mock.calls[0]![0]).toBe("https://api.fake-email.pro/v1/mailboxes/a%40example.org");
  });

  it("tolerates a trailing slash and a path prefix in baseUrl", async () => {
    const { client, requests } = setup([json(mailbox)], { baseUrl: "https://gw.test/fake/" });
    await client.mailboxes.get("a@example.org");
    expect(requests[0]!.url.toString()).toBe("https://gw.test/fake/v1/mailboxes/a%40example.org");
  });
});

describe("headers", () => {
  it("sends auth, accept and the SDK user agent", async () => {
    const { client, requests } = setup([json(mailbox)]);
    await client.mailboxes.get("a@example.org");
    const h = requests[0]!.headers;
    expect(h.get("authorization")).toBe("Bearer fep_test");
    expect(h.get("accept")).toBe("application/json");
    expect(h.get("user-agent")).toBe(`fake-email-pro-js/${pkg.version}`);
    expect(h.get("content-type")).toBeNull();
  });

  it("appends a custom user agent", async () => {
    const { client, requests } = setup([json(mailbox)], { userAgent: "my-suite/1.0" });
    await client.mailboxes.get("a@example.org");
    expect(requests[0]!.headers.get("user-agent")).toBe(`fake-email-pro-js/${pkg.version} my-suite/1.0`);
  });

  it("VERSION matches package.json", () => {
    expect(VERSION).toBe(pkg.version);
  });
});
