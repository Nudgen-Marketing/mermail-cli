import { setTimeout as delay } from "node:timers/promises";
import { apiRequest, CliError, type ClientOptions } from "./client.js";

export const DEFAULT_EMAIL_WAIT_TIMEOUT = 120_000;
export const DEFAULT_EMAIL_POLL_INTERVAL = 30_000;

export type WaitForEmailOptions = {
  mailboxId: string;
  query?: string;
  from?: string;
  subject?: string;
  folder?: string;
  after?: string;
  waitTimeout: number;
  pollInterval: number;
};

type WaitRuntime = {
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<unknown>;
};

export async function waitForEmail(client: ClientOptions, options: WaitForEmailOptions, runtime: WaitRuntime = {}): Promise<unknown> {
  const now = runtime.now ?? Date.now;
  const sleep = runtime.sleep ?? delay;
  const deadline = now() + options.waitTimeout;
  const query = compact({
    query: options.query,
    from: options.from,
    subject: options.subject,
    folder: options.folder,
    date_start: options.after,
    page: "1",
    limit: "25",
  });

  while (true) {
    const { data } = await apiRequest(client, {
      method: "GET",
      path: `/api/v1/mailboxes/${encodeURIComponent(options.mailboxId)}/search`,
      query,
    });
    const match = newestEmail(data);
    if (match) {
      const id = typeof match.id === "string" ? match.id : "";
      if (id) {
        const result = await apiRequest(client, {
          method: "GET",
          path: `/api/v1/mailboxes/${encodeURIComponent(options.mailboxId)}/emails/${encodeURIComponent(id)}`,
        });
        return result.data;
      }
    }

    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(options.pollInterval, remaining));
  }

  throw new CliError(
    `No matching email arrived within ${options.waitTimeout} milliseconds`,
    5,
    408,
    "email_wait_timeout",
    {
      mailboxId: options.mailboxId,
      filters: {
        query: options.query,
        from: options.from,
        subject: options.subject,
        folder: options.folder,
        after: options.after,
      },
    },
  );
}

function newestEmail(value: unknown): Record<string, unknown> | undefined {
  const candidates = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.emails)
      ? value.emails
      : [];
  return candidates
    .filter(isRecord)
    .map((email, index) => ({ email, index, timestamp: emailTimestamp(email) }))
    .sort((left, right) => right.timestamp - left.timestamp || left.index - right.index)[0]?.email;
}

function emailTimestamp(email: Record<string, unknown>): number {
  for (const field of ["date", "received_at", "created_at", "receivedAt", "createdAt"]) {
    if (typeof email[field] !== "string") continue;
    const timestamp = Date.parse(email[field]);
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return 0;
}

function compact(value: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
