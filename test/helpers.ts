import { FakeEmail, type ClientOptions } from "../src/index.js";

export interface RecordedRequest {
  method: string;
  url: URL;
  headers: Headers;
  body: unknown;
  /** Per-attempt abort signal the SDK passed to fetch. */
  signal: AbortSignal | undefined;
}

export type Reply = Response | Error | ((req: RecordedRequest, clock: FakeClock) => Response | Promise<Response>);

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

export function empty(status = 204, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers });
}

export function apiError(status: number, error: string, message: string, headers: Record<string, string> = {}) {
  return json({ error, message }, status, headers);
}

/** Virtual clock: sleeping advances it instantly, so retry and wait tests take no real time. */
export class FakeClock {
  t = 1_800_000_000_000;
  sleeps: number[] = [];
  now = () => this.t;
  advance(ms: number) {
    this.t += ms;
  }
  sleep = async (ms: number, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    this.sleeps.push(ms);
    this.t += ms;
  };
}

/** A client whose fetch answers from a queue of replies and records every request. */
export function setup(replies: Reply[] = [], options: ClientOptions = {}) {
  const requests: RecordedRequest[] = [];
  const queue = [...replies];
  const clock = new FakeClock();
  const fetch = async (input: string, init: RequestInit): Promise<Response> => {
    const req: RecordedRequest = {
      method: init.method ?? "GET",
      url: new URL(input),
      headers: new Headers(init.headers),
      body: typeof init.body === "string" ? JSON.parse(init.body) : init.body,
      signal: init.signal ?? undefined,
    };
    requests.push(req);
    const next = queue.shift();
    if (next === undefined) throw new Error(`unexpected request ${req.method} ${req.url}`);
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next(req, clock) : next;
  };
  const client = new FakeEmail({
    apiKey: "fep_test",
    baseUrl: "https://api.test",
    fetch,
    sleep: clock.sleep,
    now: clock.now,
    random: () => 0,
    ...options,
  });
  return { client, requests, clock, remaining: () => queue.length };
}

export const mailbox = {
  address: "ci-runner-7@example.org",
  activeSince: "2026-10-22T09:00:00.481Z",
  expiresAt: "2026-10-23T09:00:00.481Z",
  storageUsedBytes: 0,
  messagesCount: 0,
};

export function simpleMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: "5d2e8a10-7b3c-4f1e-8a2d-9c4b6e1f3a57",
    mailboxAddress: "ci-runner-7@example.org",
    createdAt: "2026-10-22T09:06:40.102Z",
    sizeBytes: 9120,
    from: { name: "Acme", address: "no-reply@acme.example" },
    subject: "Your verification code",
    bodyState: "STORED",
    attachmentsCount: 0,
    code: "048213",
    confirmLink: "https://acme.example/verify?t=3f9a",
    ...overrides,
  };
}

export function detailedMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: "5d2e8a10-7b3c-4f1e-8a2d-9c4b6e1f3a57",
    createdAt: "2026-10-22T09:06:40.102Z",
    from: { name: null, address: "sender@example.com" },
    subject: "Welcome",
    bodyState: "STORED",
    html: "<p>hi</p>",
    text: null,
    attachments: [],
    codes: [],
    links: [],
    ...overrides,
  };
}

export function page<T>(content: T[], p = 0, totalPages = 1) {
  return { content, page: p, size: 50, totalPages, totalElements: content.length };
}
