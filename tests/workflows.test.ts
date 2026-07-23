import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveClientOptions } from "../src/client.js";
import { DEFAULT_EMAIL_POLL_INTERVAL, DEFAULT_EMAIL_WAIT_TIMEOUT, waitForEmail } from "../src/workflows.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("email wait workflow", () => {
  it("makes at most five searches at the default 30-second interval and 120-second boundary", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => Response.json({ emails: [], totalCount: 0 }));
    vi.stubGlobal("fetch", fetchMock);
    let now = 0;

    const result = waitForEmail(
      resolveClientOptions({ apiKey: "sk-proj-test" }),
      {
        mailboxId: "agent@mermail.app",
        subject: "Verify",
        waitTimeout: DEFAULT_EMAIL_WAIT_TIMEOUT,
        pollInterval: DEFAULT_EMAIL_POLL_INTERVAL,
      },
      {
        now: () => now,
        sleep: async (milliseconds) => { now += milliseconds; },
      },
    );

    await expect(result).rejects.toMatchObject({ code: "email_wait_timeout" });
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(now).toBe(120_000);
  });
});
