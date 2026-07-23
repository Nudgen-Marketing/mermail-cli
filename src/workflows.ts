import { setTimeout as delay } from "node:timers/promises";
import { createHash } from "node:crypto";
import { apiRequest, CliError, type ApiRequestInput, type ClientOptions } from "./client.js";

export const DEFAULT_EMAIL_WAIT_TIMEOUT = 120_000;
export const DEFAULT_EMAIL_POLL_INTERVAL = 30_000;

export type WaitForEmailOptions = {
  mailboxId: string;
  query?: string;
  from?: string;
  fromExact?: string;
  to?: string;
  toExact?: string;
  subject?: string;
  folder?: string;
  after?: string;
  requireSingleMatch?: boolean;
  requireScanStatus?: string;
  rejectFlagged?: boolean;
  metadataOnly?: boolean;
  includeHeld?: boolean;
  excludeEmailIds?: string[];
  waitTimeout: number;
  pollInterval: number;
};

export type EnsureMailboxOptions = {
  email: string;
  name?: string;
  workspaceId?: string;
  settings?: Record<string, unknown>;
  verificationMode?: boolean;
  idempotencyKey?: string;
};

type ApiRequester = (
  client: ClientOptions,
  input: ApiRequestInput,
) => Promise<{ data: unknown; response: Response }>;

type WaitRuntime = {
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<unknown>;
  request?: ApiRequester;
};

export async function waitForEmail(
  client: ClientOptions,
  options: WaitForEmailOptions,
  runtime: WaitRuntime = {},
): Promise<unknown> {
  const now = runtime.now ?? (() => performance.now());
  const sleep = runtime.sleep ?? delay;
  const request = runtime.request ?? apiRequest;
  const deadline = now() + options.waitTimeout;
  const excludedEmailIds = new Set(
    (options.excludeEmailIds ?? []).map((id) => id.trim()).filter(Boolean),
  );
  const query = compact({
    query: options.query,
    from: options.fromExact ?? options.from,
    to: options.toExact ?? options.to,
    subject: options.subject,
    folder: options.folder,
    date_start: options.after,
    require_scan_status: options.requireScanStatus,
    metadata_only: options.metadataOnly ? "true" : undefined,
    include_held: options.includeHeld ? "true" : undefined,
    page: "1",
    limit: "25",
  });

  while (remainingMilliseconds(deadline, now) > 0) {
    let searchData: unknown;
    try {
      const result = await boundedRequest(request, client, {
        method: "GET",
        path: `/api/v1/mailboxes/${encodeURIComponent(options.mailboxId)}/search`,
        query,
      }, deadline, now);
      searchData = result.data;
    } catch (error) {
      if (isInvalidResponse(error)) throw emailWaitInvalidResponse("Email search returned an invalid response", error);
      if (!isTransientWaitError(error)) throw error;
      if (remainingMilliseconds(deadline, now) <= 0) break;
      await boundedSleep(waitDelay(error, options.pollInterval), deadline, now, sleep);
      continue;
    }
    if (remainingMilliseconds(deadline, now) <= 0) break;

    const search = parseEmailSearch(searchData);
    const candidates = sortNewest(search.emails
      .filter((email) => summaryMatches(email, options))
      // The Mermail email id is authoritative. RFC/provider message_id is only
      // a secondary correlation key for older baseline captures.
      .filter((email) => !isExcludedEmail(email, excludedEmailIds)));
    if (
      options.requireSingleMatch &&
      (candidates.length > 1 || search.totalCount > search.emails.length)
    ) {
      throw new CliError(
        "More than one email matched the verification workflow",
        5,
        409,
        "email_wait_ambiguous",
        {
          mailboxId: options.mailboxId,
          candidateCount: candidates.length,
          totalCount: search.totalCount,
        },
      );
    }

    const match = candidates[0];
    if (match) {
      const id = typeof match.id === "string" ? match.id : "";
      if (!id) throw emailWaitInvalidResponse("Email search result is missing an id");
      let full: unknown;
      try {
        const result = await boundedRequest(request, client, {
          method: "GET",
          path: `/api/v1/mailboxes/${encodeURIComponent(options.mailboxId)}/emails/${encodeURIComponent(id)}`,
          query: compact({
            metadata_only: options.metadataOnly ? "true" : undefined,
            include_held: options.includeHeld ? "true" : undefined,
          }),
        }, deadline, now);
        full = result.data;
      } catch (error) {
        if (isInvalidResponse(error)) throw emailWaitInvalidResponse("Email detail returned an invalid response", error);
        if (!isTransientWaitError(error)) throw error;
        if (remainingMilliseconds(deadline, now) <= 0) break;
        await boundedSleep(waitDelay(error, options.pollInterval), deadline, now, sleep);
        continue;
      }
      if (remainingMilliseconds(deadline, now) <= 0) break;

      if (!isRecord(full) || typeof full.id !== "string") {
        throw emailWaitInvalidResponse("Email detail response is missing an id");
      }
      if (full.id !== id) {
        throw emailWaitInvalidResponse("Email detail response id does not match the search result");
      }
      const validated = { ...match, ...full };
      if (
        !isExcludedEmail(validated, excludedEmailIds) &&
        fullEmailMatches(validated, options)
      ) {
        enforceScanPolicy(validated, options);
        return options.metadataOnly ? emailMetadata(validated) : full;
      }
    }

    if (remainingMilliseconds(deadline, now) <= 0) break;
    await boundedSleep(options.pollInterval, deadline, now, sleep);
  }

  throw emailWaitTimeout(options);
}

export async function ensureMailbox(
  client: ClientOptions,
  options: EnsureMailboxOptions,
  request: ApiRequester = apiRequest,
): Promise<{
  mailbox: Record<string, unknown>;
  created: boolean;
  resolution: "existing" | "created" | "conflict_relisted";
}> {
  const email = normalizeExpectedEmail(options.email, "--email");
  const workspaceId = options.workspaceId?.trim() || undefined;
  const settings = verificationSettings(options.settings, options.verificationMode);
  const purpose = mailboxPurpose(settings);
  let mailboxes = await listMailboxes(request, client, workspaceId);
  const exact = mailboxes.filter((mailbox) => mailboxEmail(mailbox) === email);
  const usable = exact.filter(isUsableMailbox);
  const suitable = usable.filter((mailbox) => mailboxSupportsPurpose(mailbox, purpose));
  if (suitable.length > 1) throw mailboxEnsureAmbiguous(email, suitable.length);
  if (suitable[0]) return { mailbox: suitable[0], created: false, resolution: "existing" };
  if (usable.length) throw mailboxPurposeMismatch(email, purpose);
  if (exact.length) {
    throw new CliError(
      `Mailbox ${email} exists but cannot currently receive email`,
      1,
      409,
      "mailbox_ensure_unusable",
      { email, matches: exact.map(mailboxIdentity) },
    );
  }

  const name = options.name?.trim();
  if (!name) {
    throw new CliError("--name is required when mailboxes ensure needs to create a mailbox", 2, 400, "mailbox_name_required");
  }

  const domain = email.slice(email.lastIndexOf("@") + 1);
  const knownHostedOrReceivingDomain = domain === "mermail.app" || mailboxes.some((mailbox) =>
    mailboxEmail(mailbox).endsWith(`@${domain}`) && isUsableMailbox(mailbox)
  );
  const resolvedWorkspaceId = workspaceId ?? (
    knownHostedOrReceivingDomain
      ? undefined
      : await resolveWorkspaceId(request, client, mailboxes)
  );
  await assertMailboxDomainUsable(request, client, email, resolvedWorkspaceId, mailboxes);
  const body: Record<string, unknown> = {
    email,
    name,
    ...(resolvedWorkspaceId ? { workspaceId: resolvedWorkspaceId } : {}),
    ...(settings ? { settings } : {}),
  };
  const idempotencyKey = options.idempotencyKey?.trim() || mailboxEnsureIdempotencyKey(
    email,
    purpose,
    resolvedWorkspaceId ?? "bound-workspace",
  );

  try {
    const result = await request(client, {
      method: "POST",
      path: "/api/v1/mailboxes",
      body,
      idempotencyKey,
      maxAttempts: 1,
    });
    if (!isRecord(result.data)) throw mailboxEnsureInvalidResponse("Mailbox create returned an invalid response");
    return { mailbox: result.data, created: true, resolution: "created" };
  } catch (error) {
    if (!(error instanceof CliError) || error.status !== 409) throw error;
    mailboxes = await listMailboxes(request, client, workspaceId);
    const relistedUsable = mailboxes.filter((mailbox) => mailboxEmail(mailbox) === email && isUsableMailbox(mailbox));
    const relisted = relistedUsable.filter((mailbox) => mailboxSupportsPurpose(mailbox, purpose));
    if (relisted.length > 1) throw mailboxEnsureAmbiguous(email, relisted.length);
    if (relisted[0]) return { mailbox: relisted[0], created: false, resolution: "conflict_relisted" };
    if (relistedUsable.length) throw mailboxPurposeMismatch(email, purpose);
    throw error;
  }
}

async function boundedRequest(
  request: ApiRequester,
  client: ClientOptions,
  input: ApiRequestInput,
  deadline: number,
  now: () => number,
) {
  const remaining = remainingMilliseconds(deadline, now);
  if (remaining <= 0) throw emailWaitTimeoutFromDeadline();
  return request(client, {
    ...input,
    maxAttempts: 1,
    budgetMs: Math.max(1, Math.ceil(remaining)),
  });
}

async function boundedSleep(
  requested: number,
  deadline: number,
  now: () => number,
  sleep: (milliseconds: number) => Promise<unknown>,
) {
  const remaining = remainingMilliseconds(deadline, now);
  if (remaining <= 0) return;
  await sleep(Math.min(Math.max(0, requested), remaining));
}

function remainingMilliseconds(deadline: number, now: () => number) {
  return Math.max(0, deadline - now());
}

function waitDelay(error: unknown, fallback: number) {
  return error instanceof CliError && error.retryAfterMs !== undefined
    ? error.retryAfterMs
    : fallback;
}

function isTransientWaitError(error: unknown) {
  if (!(error instanceof CliError)) return true;
  return error.code === "request_timeout" || [408, 502, 503, 504].includes(error.status ?? 0);
}

function isInvalidResponse(error: unknown) {
  return error instanceof CliError && error.code === "invalid_response";
}

function parseEmailSearch(value: unknown): { emails: Record<string, unknown>[]; totalCount: number } {
  const rawEmails = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.emails)
      ? value.emails
      : undefined;
  if (!rawEmails || rawEmails.some((email) => !isRecord(email))) {
    throw emailWaitInvalidResponse("Email search response must contain an emails array");
  }
  const total = isRecord(value) && value.totalCount !== undefined ? value.totalCount : rawEmails.length;
  if (!Number.isSafeInteger(total) || Number(total) < 0) {
    throw emailWaitInvalidResponse("Email search response has an invalid totalCount");
  }
  return { emails: rawEmails as Record<string, unknown>[], totalCount: Number(total) };
}

function sortNewest(emails: Record<string, unknown>[]) {
  return emails
    .map((email, index) => ({ email, index, timestamp: emailTimestamp(email) }))
    .sort((left, right) => right.timestamp - left.timestamp || left.index - right.index)
    .map(({ email }) => email);
}

function summaryMatches(email: Record<string, unknown>, options: WaitForEmailOptions) {
  if (options.from && !containsText(email.sender, options.from)) return false;
  if (options.fromExact && !senderMatchesExact(email.sender, options.fromExact)) return false;
  if (options.to && !containsText(recipientText(email), options.to)) return false;
  if (options.toExact && !recipientMatchesExact(email, options.toExact)) return false;
  if (options.subject && !containsText(email.subject, options.subject)) return false;
  if (options.after && !isOnOrAfter(email, options.after)) return false;
  return true;
}

function fullEmailMatches(email: Record<string, unknown>, options: WaitForEmailOptions) {
  if (!summaryMatches(email, options)) return false;
  if (!options.query) return true;
  if (
    options.metadataOnly &&
    typeof email.body !== "string" &&
    typeof email.snippet !== "string"
  ) {
    // The server applied the free-text filter before omitting content. Exact
    // address/time filters above remain independently revalidated.
    return true;
  }
  const fields = [
    email.subject,
    email.body,
    email.snippet,
    email.sender,
    recipientText(email),
  ];
  const searchable = fields.filter((value): value is string => typeof value === "string").join("\n");
  return searchable ? containsText(searchable, options.query) : true;
}

function isOnOrAfter(email: Record<string, unknown>, after: string) {
  const timestamp = emailTimestamp(email);
  const minimum = Date.parse(after);
  return timestamp > 0 && Number.isFinite(minimum) && timestamp >= minimum;
}

function emailTimestamp(email: Record<string, unknown>): number {
  for (const field of ["date", "received_at", "created_at", "receivedAt", "createdAt"]) {
    if (typeof email[field] !== "string") continue;
    const timestamp = Date.parse(email[field]);
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return 0;
}

function containsText(value: unknown, expected: string) {
  return typeof value === "string" && value.toLocaleLowerCase("en-US").includes(expected.trim().toLocaleLowerCase("en-US"));
}

function senderMatchesExact(value: unknown, expected: string) {
  const addresses = emailAddresses(value);
  return addresses.length === 1 && addresses[0] === normalizeExpectedEmail(expected, "--from-exact");
}

function recipientMatchesExact(email: Record<string, unknown>, expected: string) {
  const normalized = normalizeExpectedEmail(expected, "--to-exact");
  return emailAddresses([email.recipient, email.to, email.cc, email.bcc]).includes(normalized);
}

function recipientText(email: Record<string, unknown>) {
  return [email.recipient, email.to, email.cc, email.bcc]
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .filter((value): value is string => typeof value === "string")
    .join(", ");
}

function emailAddresses(value: unknown): string[] {
  const text = (Array.isArray(value) ? value.flat(Infinity) : [value])
    .filter((entry): entry is string => typeof entry === "string")
    .join(",");
  const matches = text.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+/giu) ?? [];
  return [...new Set(matches.map((address) => address.toLocaleLowerCase("en-US")))];
}

function normalizeExpectedEmail(value: string, flag: string) {
  const normalized = value.trim().toLocaleLowerCase("en-US");
  if (emailAddresses(normalized).length !== 1 || emailAddresses(normalized)[0] !== normalized || normalized.length > 254) {
    throw new CliError(`${flag} must be one bare email address`, 2);
  }
  return normalized;
}

function enforceScanPolicy(email: Record<string, unknown>, options: WaitForEmailOptions) {
  const status = typeof email.scan_status === "string"
    ? email.scan_status.toLocaleLowerCase("en-US")
    : null;
  if (options.rejectFlagged && status === "flagged") {
    throw new CliError(
      "Matching email was flagged by the security scanner",
      5,
      422,
      "email_wait_flagged",
      { emailId: email.id, scanStatus: status },
    );
  }
  if (options.requireScanStatus && status !== options.requireScanStatus.toLocaleLowerCase("en-US")) {
    throw new CliError(
      `Matching email scan status is ${status ?? "missing"}, expected ${options.requireScanStatus}`,
      5,
      422,
      "email_wait_scan_status_mismatch",
      { emailId: email.id, scanStatus: status, expected: options.requireScanStatus },
    );
  }
}

function emailMetadata(email: Record<string, unknown>) {
  const fields = [
    "id",
    "subject",
    "sender",
    "recipient",
    "cc",
    "bcc",
    "date",
    "read",
    "starred",
    "is_urgent",
    "category",
    "in_reply_to",
    "email_references",
    "thread_id",
    "folder_id",
    "delivery_status",
    "message_id",
    "scan_status",
    "body_storage_status",
    "content_omitted",
  ];
  const metadata = Object.fromEntries(fields.filter((field) => email[field] !== undefined).map((field) => [field, email[field]]));
  const attachments = Array.isArray(email.attachments) ? email.attachments : [];
  const attachmentCount = Number.isSafeInteger(email.attachment_count)
    ? Number(email.attachment_count)
    : attachments.length;
  return { ...metadata, content_omitted: true, attachment_count: attachmentCount };
}

function emailWaitTimeout(options: WaitForEmailOptions) {
  return new CliError(
    `No matching email arrived within ${options.waitTimeout} milliseconds`,
    5,
    408,
    "email_wait_timeout",
    {
      mailboxId: options.mailboxId,
      filters: {
        query: options.query,
        from: options.from,
        fromExact: options.fromExact,
        to: options.to,
        toExact: options.toExact,
        subject: options.subject,
        folder: options.folder,
        after: options.after,
        requireScanStatus: options.requireScanStatus,
        excludeEmailIds: options.excludeEmailIds,
      },
    },
  );
}

function emailWaitTimeoutFromDeadline() {
  return new CliError("Email wait deadline elapsed", 5, 408, "email_wait_timeout");
}

function emailWaitInvalidResponse(message: string, cause?: unknown) {
  return new CliError(
    message,
    5,
    502,
    "email_wait_invalid_response",
    cause instanceof Error ? { cause: cause.message } : undefined,
  );
}

async function listMailboxes(request: ApiRequester, client: ClientOptions, workspaceId?: string) {
  const result = await request(client, {
    method: "GET",
    path: "/api/v1/mailboxes",
    query: compact({ workspaceId }),
  });
  if (!Array.isArray(result.data) || result.data.some((mailbox) => !isRecord(mailbox))) {
    throw mailboxEnsureInvalidResponse("Mailbox list returned an invalid response");
  }
  return result.data as Record<string, unknown>[];
}

function mailboxEmail(mailbox: Record<string, unknown>) {
  return typeof mailbox.email === "string" ? mailbox.email.trim().toLocaleLowerCase("en-US") : "";
}

function isUsableMailbox(mailbox: Record<string, unknown>) {
  if (mailbox.disabled_at !== null && mailbox.disabled_at !== undefined && mailbox.disabled_at !== "") return false;
  if (mailbox.can_receive === false) return false;
  if (typeof mailbox.receiving_status === "string" && mailbox.receiving_status !== "ready") return false;
  if (typeof mailbox.inbound_provider === "string" && ["disabled", "none", "unavailable"].includes(mailbox.inbound_provider.toLocaleLowerCase("en-US"))) return false;
  return Boolean(mailboxEmail(mailbox));
}

function mailboxIdentity(mailbox: Record<string, unknown>) {
  return {
    id: mailbox.id,
    public_id: mailbox.public_id,
    email: mailbox.email,
    disabled_at: mailbox.disabled_at,
    receiving_status: mailbox.receiving_status,
  };
}

function mailboxEnsureAmbiguous(email: string, count: number) {
  return new CliError(
    `More than one usable mailbox matched ${email}`,
    1,
    409,
    "mailbox_ensure_ambiguous",
    { email, candidateCount: count },
  );
}

function mailboxPurposeMismatch(email: string, purpose: "standard" | "verification") {
  return new CliError(
    `Mailbox ${email} exists but is not configured for ${purpose} workflows`,
    1,
    409,
    "mailbox_ensure_purpose_mismatch",
    { email, purpose },
  );
}

function mailboxEnsureInvalidResponse(message: string) {
  return new CliError(message, 1, 502, "mailbox_ensure_invalid_response");
}

async function resolveWorkspaceId(
  request: ApiRequester,
  client: ClientOptions,
  mailboxes: Record<string, unknown>[],
) {
  const mailboxWorkspaceIds = uniqueStrings(mailboxes.map((mailbox) => mailbox.workspace_id));
  if (mailboxWorkspaceIds.length === 1) return mailboxWorkspaceIds[0];
  const result = await request(client, { method: "GET", path: "/api/v1/workspaces" });
  const workspaces = Array.isArray(result.data)
    ? result.data
    : isRecord(result.data) && Array.isArray(result.data.workspaces)
      ? result.data.workspaces
      : undefined;
  if (!workspaces || workspaces.some((workspace) => !isRecord(workspace))) {
    throw mailboxEnsureInvalidResponse("Workspace list returned an invalid response");
  }
  const ids = uniqueStrings(workspaces.map((workspace) => isRecord(workspace) ? workspace.id : undefined));
  if (ids.length === 1) return ids[0];
  if (ids.length > 1 || mailboxWorkspaceIds.length > 1) {
    throw new CliError(
      "More than one workspace is available; pass --workspace-id",
      2,
      409,
      "mailbox_workspace_ambiguous",
      { workspaceCount: Math.max(ids.length, mailboxWorkspaceIds.length) },
    );
  }
  return undefined;
}

async function assertMailboxDomainUsable(
  request: ApiRequester,
  client: ClientOptions,
  email: string,
  workspaceId: string | undefined,
  mailboxes: Record<string, unknown>[],
) {
  const domain = email.slice(email.lastIndexOf("@") + 1);
  if (domain === "mermail.app") return;
  if (mailboxes.some((mailbox) => mailboxEmail(mailbox).endsWith(`@${domain}`) && isUsableMailbox(mailbox))) return;
  if (!workspaceId) {
    throw new CliError(
      "A workspace id is required to verify this custom mailbox domain",
      2,
      400,
      "mailbox_workspace_required",
      { domain },
    );
  }
  const result = await request(client, {
    method: "GET",
    path: `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/email-domains`,
  });
  if (!Array.isArray(result.data) || result.data.some((entry) => !isRecord(entry))) {
    throw mailboxEnsureInvalidResponse("Email domain list returned an invalid response");
  }
  const match = (result.data as Record<string, unknown>[]).find((entry) =>
    typeof entry.domain === "string" && entry.domain.toLocaleLowerCase("en-US") === domain
  );
  const hasCapabilityFields =
    match &&
    (typeof match.can_send === "boolean" ||
      typeof match.can_receive === "boolean");
  const ready = Boolean(
    match &&
      (hasCapabilityFields
        ? match.can_send === true && match.can_receive === true
        : match.status === "verified"),
  );
  if (!ready) {
    throw new CliError(
      `Mailbox domain ${domain} is not verified for sending and receiving`,
      1,
      409,
      "mailbox_domain_unavailable",
      { domain, workspaceId },
    );
  }
}

function verificationSettings(
  settings: Record<string, unknown> | undefined,
  verificationMode: boolean | undefined,
) {
  if (!settings && !verificationMode) return undefined;
  const result = { ...(settings ?? {}) };
  if (verificationMode) {
    const existing = isRecord(result.agentInbox) ? result.agentInbox : {};
    result.agentInbox = {
      ...existing,
      mode: "verification",
      automationsEnabled: false,
    };
  }
  return result;
}

function mailboxEnsureIdempotencyKey(
  email: string,
  purpose: "standard" | "verification",
  workspaceContext: string,
) {
  const digest = createHash("sha256")
    .update(["mailbox-ensure-v1", workspaceContext, email, purpose].join("\n"))
    .digest("hex")
    .slice(0, 40);
  return `mailbox-ensure-v1-${digest}`;
}

function mailboxPurpose(settings: Record<string, unknown> | undefined): "standard" | "verification" {
  const agentInbox = settings && isRecord(settings.agentInbox) ? settings.agentInbox : undefined;
  return agentInbox?.mode === "verification" ? "verification" : "standard";
}

function mailboxSupportsPurpose(
  mailbox: Record<string, unknown>,
  purpose: "standard" | "verification",
) {
  if (purpose === "standard") return true;
  const settings = isRecord(mailbox.settings) ? mailbox.settings : undefined;
  const agentInbox = settings && isRecord(settings.agentInbox) ? settings.agentInbox : undefined;
  return agentInbox?.mode === "verification" && agentInbox.automationsEnabled === false;
}

function uniqueStrings(values: unknown[]) {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && Boolean(value.trim())).map((value) => value.trim()))];
}

function isExcludedEmail(
  email: Record<string, unknown>,
  excluded: ReadonlySet<string>,
) {
  if (!excluded.size) return false;
  const id = typeof email.id === "string" ? email.id.trim() : "";
  if (id && excluded.has(id)) return true;
  const providerMessageId = typeof email.message_id === "string"
    ? email.message_id.trim()
    : "";
  return Boolean(providerMessageId && excluded.has(providerMessageId));
}

function compact(value: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
