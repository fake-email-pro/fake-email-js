// Live smoke test against a real server. Skipped unless FAKE_EMAIL_LIVE=1 and FAKE_EMAIL_API_KEY are set;
// FAKE_EMAIL_BASE_URL points it at another environment. Spends one mailbox of the monthly quota.
import { describe, expect, it } from "vitest";
import { FakeEmail, NotFoundError } from "../src/index.js";

const live = process.env.FAKE_EMAIL_LIVE === "1" && !!process.env.FAKE_EMAIL_API_KEY;

describe.skipIf(!live)("live API", () => {
  it("creates, reads and deletes a mailbox", async () => {
    const client = new FakeEmail({
      baseUrl: process.env.FAKE_EMAIL_BASE_URL || undefined,
      userAgent: "fake-email-pro-js-live-test",
    });

    const domains = await client.domains.list();
    expect(domains.length).toBeGreaterThan(0);

    const limits = await client.limits.get();
    expect(limits.requestsPerMinute).toBeGreaterThan(0);

    const mailbox = await client.mailboxes.create();
    try {
      expect(mailbox.address).toMatch(/@/);
      await expect(client.mailboxes.get(mailbox.address)).resolves.toMatchObject({ address: mailbox.address });
      const page = await client.messages.list(mailbox.address);
      expect(page.content).toEqual([]);
      await expect(client.messages.wait(mailbox.address, { timeout: 1 })).resolves.toBeNull();
    } finally {
      await client.mailboxes.delete(mailbox.address);
    }
    await expect(client.mailboxes.get(mailbox.address)).rejects.toBeInstanceOf(NotFoundError);
  }, 60_000);
});
