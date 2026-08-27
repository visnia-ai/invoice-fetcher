import { mkdir, unlink } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import {
  MailSourceError,
  type MailAttachmentCandidate,
  type MailIssue,
  type MailSource,
} from "../mail/types.js";
import { createDefaultImapClient } from "./default-client.js";
import { StreamingMailParserExtractor } from "./mailparser-extractor.js";
import { runOrderedKeyedTasks, type OrderedTaskResult } from "./ordered-worker-pool.js";
import { extractPlannedMessageParts } from "./part-extractor.js";
import type {
  ExtractedAttachment,
  ImapClient,
  ImapConnectionProfile,
  ImapMailSearchResult,
  ImapMailSourceDependencies,
  ImapMailbox,
  ImapMessageMetadata,
  ImapProfileResolver,
  ImapProgressEvent,
  ImapSearchOptions,
  MimeExtractionResult,
} from "./types.js";

const EXCLUDED_SPECIAL_USES = new Set([
  "\\drafts",
  "\\junk",
  "\\outbox",
  "\\sent",
  "\\spam",
  "\\trash",
]);
const GMAIL_ALL_MAIL_SPECIAL_USES = new Set(["\\all", "\\allmail"]);
const EXCLUDED_CONVENTIONAL_NAMES = new Set([
  "deleted items",
  "drafts",
  "junk",
  "junk email",
  "outbox",
  "sent",
  "sent items",
  "sent mail",
  "spam",
  "trash",
]);
const ALL_MAIL_CONVENTIONAL_NAMES = new Set(["all mail", "allmail"]);
const METADATA_BATCH_SIZE = 250;
const DEFAULT_MAXIMUM_CONNECTIONS = 3;
const MAXIMUM_BUFFERED_RESULTS = 6;

interface MessageTask {
  uid: number;
  metadataResult: Awaited<ReturnType<ImapClient["fetchMetadataBatch"]>>[number] | undefined;
}

interface MessageOutcome {
  messageId?: string;
  normalizedMessageId?: string;
  metadata?: ImapMessageMetadata;
  attachments: ExtractedAttachment[];
  emailContextMatches: boolean;
  emailReceiptMatches: boolean;
  issues: MailIssue[];
  deduplicateFuture: boolean;
}

interface WorkerLock {
  client: ImapClient;
  lock: Awaited<ReturnType<ImapClient["lockMailbox"]>>;
}

export class ImapMailSource implements MailSource {
  private readonly dependencies: ImapMailSourceDependencies;

  constructor(
    private readonly resolveProfile: ImapProfileResolver,
    dependencies: Partial<ImapMailSourceDependencies> = {},
  ) {
    this.dependencies = {
      clientFactory: dependencies.clientFactory ?? createDefaultImapClient,
      mimeExtractor: dependencies.mimeExtractor ?? new StreamingMailParserExtractor(),
      maximumConnections: normalizeMaximumConnections(dependencies.maximumConnections),
    };
  }

  async search(options: ImapSearchOptions): Promise<ImapMailSearchResult> {
    validateOptions(options);
    const stagingDirectory = isAbsolute(options.stagingDirectory)
      ? options.stagingDirectory
      : resolve(options.stagingDirectory);
    await mkdir(stagingDirectory, { recursive: true });

    let profile: ImapConnectionProfile;
    try {
      profile = await this.resolveProfile(options.accountEmail.trim());
      validateProfile(profile);
    } catch (error) {
      if (error instanceof MailSourceError) throw error;
      throw accessError("The configured mail account could not be loaded", error);
    }

    emit(options, {
      type: "connection-started",
      provider: profile.provider,
      host: profile.host,
    });

    let client: ImapClient;
    try {
      client = await this.dependencies.clientFactory(profile);
    } catch (error) {
      throw accessError(`Could not create an IMAP connection for ${profile.host}`, error);
    }
    try {
      await client.connect();
    } catch (error) {
      await client.logout().catch(() => undefined);
      throw accessError(`Could not connect or authenticate to ${profile.host}`, error);
    }

    emit(options, {
      type: "authenticated",
      provider: profile.provider,
      accountEmail: profile.email,
    });
    emit(options, { type: "account-selected", accountName: profile.email });

    const clients = [client];
    try {
      const additionalCandidates: ImapClient[] = [];
      for (let index = 1; index < this.dependencies.maximumConnections; index += 1) {
        try {
          const additional = await this.dependencies.clientFactory(profile);
          if (!clients.includes(additional) && !additionalCandidates.includes(additional)) {
            additionalCandidates.push(additional);
          }
        } catch {}
      }
      const connectedAdditional = await Promise.all(
        additionalCandidates.map(async (additional) => {
          try {
            await additional.connect();
            return additional;
          } catch {
            await additional.logout().catch(() => undefined);
            return undefined;
          }
        }),
      );
      clients.push(...connectedAdditional.filter((entry): entry is ImapClient => !!entry));
      const mailboxes = selectReceivedMailboxes(await client.listMailboxes(), profile.provider);
      return await this.searchMailboxes(clients, profile, mailboxes, stagingDirectory, options);
    } catch (error) {
      if (error instanceof MailSourceError) throw error;
      throw accessError("The IMAP mailbox list could not be read", error);
    } finally {
      await Promise.all(clients.map((entry) => entry.logout().catch(() => undefined)));
    }
  }

  private async searchMailboxes(
    clients: ImapClient[],
    profile: ImapConnectionProfile,
    mailboxes: readonly ImapMailbox[],
    stagingDirectory: string,
    options: ImapSearchOptions,
  ): Promise<ImapMailSearchResult> {
    const client = clients[0];
    if (!client) throw new Error("The primary IMAP session is unavailable.");
    const attachments: MailAttachmentCandidate[] = [];
    const issues: MailIssue[] = [];
    const seenMessages = new Set<string>();
    const seenAttachments = new Set<string>();
    let scannedMessages = 0;

    const mailboxPlans: Array<{
      mailbox: ImapMailbox;
      uids: readonly number[];
      searchError?: string;
    }> = [];

    for (const mailbox of mailboxes) {
      let lock: Awaited<ReturnType<ImapClient["lockMailbox"]>> | undefined;
      try {
        lock = await client.lockMailbox(mailbox.path);
        mailboxPlans.push({
          mailbox,
          uids: await searchReceivedMessages(client, profile, options),
        });
      } catch (error) {
        mailboxPlans.push({ mailbox, uids: [], searchError: errorMessage(error) });
      } finally {
        lock?.release();
      }
    }

    const totalMessages = mailboxPlans.reduce((total, plan) => total + plan.uids.length, 0);
    emit(options, {
      type: "scan-started",
      scannedMessages,
      totalMessages,
      attachmentsStaged: attachments.length,
    });

    for (const plan of mailboxPlans) {
      const { mailbox, uids } = plan;
      emit(options, {
        type: "mailbox-started",
        mailboxName: mailbox.path,
        scannedMessages,
        totalMessages,
        attachmentsStaged: attachments.length,
      });
      const workerLocks: WorkerLock[] = [];
      const replacementAttempts = new Set<ImapClient>();
      const failedClients = new Set<ImapClient>();
      const unpublishedPaths = new Set<string>();
      try {
        if (plan.searchError !== undefined) {
          throw new Error(plan.searchError);
        }
        workerLocks.push({ client, lock: await client.lockMailbox(mailbox.path) });
        for (const additional of clients.slice(1)) {
          try {
            workerLocks.push({
              client: additional,
              lock: await additional.lockMailbox(mailbox.path),
            });
          } catch {
            // Secondary sessions are an optimization and may degrade independently.
          }
        }
        for (const uidBatch of batches(uids, METADATA_BATCH_SIZE)) {
          let metadataResults: Awaited<ReturnType<ImapClient["fetchMetadataBatch"]>>;
          try {
            metadataResults = await client.fetchMetadataBatch(uidBatch);
          } catch (error) {
            metadataResults = uidBatch.map((uid) => ({
              kind: "error" as const,
              uid,
              message: errorMessage(error),
            }));
          }
          const metadataByUid = new Map(metadataResults.map((result) => [result.uid, result]));
          const workerPool = new ClientLeasePool(
            workerLocks
              .map((entry) => entry.client)
              .filter((entry) => !failedClients.has(entry)),
          );
          const tasks = uidBatch.map((uid): MessageTask => ({
            uid,
            metadataResult: metadataByUid.get(uid),
          }));
          await runOrderedKeyedTasks<MessageTask, string, MessageOutcome>(tasks, {
              concurrency: Math.max(1, workerPool.size),
              maximumPendingResults:
                Math.max(1, workerPool.size) + MAXIMUM_BUFFERED_RESULTS,
              keyOf: (task) => messageTaskKey(mailbox.path, task),
              run: async (task, context) => {
                const metadataResult = task.metadataResult;
                if (metadataResult === undefined || metadataResult.kind === "error") {
                  return metadataFailureOutcome(
                    task.uid,
                    metadataResult?.message ?? "metadata was not returned",
                    mailbox.path,
                  );
                }
                const metadata = metadataResult.metadata;
                if (!messageNeedsProcessing(profile, metadata, options)) {
                  return emptyOutcome();
                }
                const stableMessageId = metadata.messageId?.trim();
                const normalizedMessageId = stableMessageId?.toLocaleLowerCase("und");
                if (
                  (normalizedMessageId && seenMessages.has(normalizedMessageId)) ||
                  previousDeduplicates(context.previous)
                ) {
                  return deduplicatedOutcome(normalizedMessageId);
                }
                if (workerPool.size === 0) {
                  throw new Error("No healthy IMAP download session remains.");
                }
                const lease = await workerPool.acquire();
                try {
                  const outcome = await this.processMessage({
                    client: lease.client,
                    mailbox,
                    uid: task.uid,
                    metadata,
                    stagingDirectory,
                    options,
                  });
                  for (const attachment of outcome.attachments) {
                    unpublishedPaths.add(attachment.stagedPath);
                  }
                  return outcome;
                } catch (error) {
                  if (isTransportFailure(error)) {
                    lease.discard();
                    failedClients.add(lease.client);
                    await this.replaceWorkerSession({
                      failedClient: lease.client,
                      profile,
                      mailbox,
                      clients,
                      workerLocks,
                      workerPool,
                      replacementAttempts,
                    });
                  }
                  throw error;
                } finally {
                  lease.release();
                }
              },
              onOrderedResult: async (result) => {
                scannedMessages += 1;
                if (result.status === "rejected") {
                  const metadata =
                    result.input.metadataResult?.kind === "success"
                      ? result.input.metadataResult.metadata
                      : undefined;
                  const messageId = metadata?.messageId?.trim() ||
                    `${mailbox.path}:uid:${result.input.uid}`;
                  issues.push({
                    code: "MESSAGE_READ_FAILED",
                    message: `Could not download or parse message ${messageId}: ${errorMessage(result.reason)}`,
                    mailbox: mailbox.path,
                    messageId,
                  });
                } else {
                  await publishOutcome({
                    outcome: result.value,
                    mailbox,
                    options,
                    attachments,
                    issues,
                    seenMessages,
                    seenAttachments,
                    unpublishedPaths,
                    scannedMessages,
                    totalMessages,
                  });
                }
                if (scannedMessages % 25 === 0) {
                  emit(options, {
                    type: "messages-scanned",
                    scannedMessages,
                    totalMessages,
                    attachmentsStaged: attachments.length,
                  });
                }
              },
            });
        }
      } catch (error) {
        await Promise.all(
          [...unpublishedPaths].map((file) => unlink(file).catch(() => undefined)),
        );
        if (error instanceof AttachmentConsumerError) throw error.originalError;
        issues.push({
          code: "MAILBOX_READ_FAILED",
          message: `Could not search mailbox ${mailbox.path}: ${errorMessage(error)}`,
          mailbox: mailbox.path,
        });
      } finally {
        for (const entry of workerLocks.reverse()) entry.lock.release();
      }
      emit(options, {
        type: "mailbox-completed",
        mailboxName: mailbox.path,
        scannedMessages,
        totalMessages,
        attachmentsStaged: attachments.length,
      });
    }

    emit(options, {
      type: "search-completed",
      scannedMessages,
      totalMessages,
      attachmentsStaged: attachments.length,
    });
    return { attachments, issues, scannedMessages };
  }

  private async replaceWorkerSession(input: {
    failedClient: ImapClient;
    profile: ImapConnectionProfile;
    mailbox: ImapMailbox;
    clients: ImapClient[];
    workerLocks: WorkerLock[];
    workerPool: ClientLeasePool;
    replacementAttempts: Set<ImapClient>;
  }): Promise<void> {
    if (input.replacementAttempts.has(input.failedClient)) return;
    input.replacementAttempts.add(input.failedClient);
    let replacement: ImapClient | undefined;
    try {
      replacement = await this.dependencies.clientFactory(input.profile);
      if (input.clients.includes(replacement)) return;
      await replacement.connect();
      const lock = await replacement.lockMailbox(input.mailbox.path);
      input.clients.push(replacement);
      input.workerLocks.push({ client: replacement, lock });
      input.workerPool.add(replacement);
    } catch {
      await replacement?.logout().catch(() => undefined);
    }
  }

  private async processMessage(input: {
    client: ImapClient;
    mailbox: ImapMailbox;
    uid: number;
    metadata: ImapMessageMetadata;
    stagingDirectory: string;
    options: ImapSearchOptions;
  }): Promise<MessageOutcome> {
    const metadata = input.metadata;
    const stableMessageId = metadata.messageId?.trim();
    const messageId = stableMessageId || `${input.mailbox.path}:uid:${input.uid}`;
    let extracted: MimeExtractionResult;
    if (metadata.partPlan) {
      const planned = await extractPlannedMessageParts({
        client: input.client,
        uid: input.uid,
        partPlan: metadata.partPlan,
        stagingDirectory: input.stagingDirectory,
        subject: metadata.subject,
        keywords: input.options.keywords,
      });
      if (planned.kind === "success") {
        extracted = planned;
      } else {
        await Promise.all(planned.stagedPaths.map((file) => unlink(file).catch(() => undefined)));
        const source = await input.client.downloadMessage(input.uid);
        extracted = await this.dependencies.mimeExtractor.extract({
          source,
          stagingDirectory: input.stagingDirectory,
          subject: metadata.subject,
          keywords: input.options.keywords,
        });
      }
    } else {
      const source = await input.client.downloadMessage(input.uid);
      extracted = await this.dependencies.mimeExtractor.extract({
        source,
        stagingDirectory: input.stagingDirectory,
        subject: metadata.subject,
        keywords: input.options.keywords,
      });
    }
    return {
      messageId,
      ...(stableMessageId
        ? { normalizedMessageId: stableMessageId.toLocaleLowerCase("und") }
        : {}),
      metadata,
      attachments: extracted.attachments,
      emailContextMatches: extracted.emailContextMatches,
      emailReceiptMatches: extracted.emailReceiptMatches,
      issues: extracted.issues.map((issue) =>
        enrichIssue(issue, input.mailbox.path, messageId)),
      deduplicateFuture: extracted.issues.length === 0,
    };
  }
}

function normalizeMaximumConnections(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAXIMUM_CONNECTIONS;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError("The maximum IMAP connection count must be a positive integer.");
  }
  return Math.min(value, DEFAULT_MAXIMUM_CONNECTIONS);
}

function messageTaskKey(mailbox: string, task: MessageTask): string {
  const metadata = task.metadataResult?.kind === "success"
    ? task.metadataResult.metadata
    : undefined;
  return metadata?.messageId?.trim().toLocaleLowerCase("und") ||
    `\0${mailbox}:uid:${task.uid}`;
}

function messageNeedsProcessing(
  profile: ImapConnectionProfile,
  metadata: ImapMessageMetadata,
  options: ImapSearchOptions,
): boolean {
  return (
    metadata.receivedAt >= options.startInclusive &&
    metadata.receivedAt < options.endExclusive &&
    !gmailMessageIsExcluded(profile, metadata) &&
    metadata.hasAttachments
  );
}

function emptyOutcome(): MessageOutcome {
  return {
    attachments: [],
    emailContextMatches: false,
    emailReceiptMatches: false,
    issues: [],
    deduplicateFuture: false,
  };
}

function deduplicatedOutcome(normalizedMessageId: string | undefined): MessageOutcome {
  return {
    ...emptyOutcome(),
    ...(normalizedMessageId ? { normalizedMessageId } : {}),
    deduplicateFuture: true,
  };
}

function metadataFailureOutcome(
  uid: number,
  message: string,
  mailbox: string,
): MessageOutcome {
  return {
    ...emptyOutcome(),
    issues: [{
      code: "MESSAGE_READ_FAILED",
      message: `Could not read message UID ${uid}: ${message}`,
      mailbox,
    }],
  };
}

function previousDeduplicates(
  previous: OrderedTaskResult<MessageTask, string, MessageOutcome> | undefined,
): boolean {
  return previous?.status === "fulfilled" && previous.value.deduplicateFuture;
}

async function publishOutcome(input: {
  outcome: MessageOutcome;
  mailbox: ImapMailbox;
  options: ImapSearchOptions;
  attachments: MailAttachmentCandidate[];
  issues: MailIssue[];
  seenMessages: Set<string>;
  seenAttachments: Set<string>;
  unpublishedPaths: Set<string>;
  scannedMessages: number;
  totalMessages: number;
}): Promise<void> {
  input.issues.push(...input.outcome.issues);
  if (input.outcome.deduplicateFuture && input.outcome.normalizedMessageId) {
    input.seenMessages.add(input.outcome.normalizedMessageId);
  }
  const metadata = input.outcome.metadata;
  const messageId = input.outcome.messageId;
  if (!metadata || !messageId) return;

  for (const attachment of input.outcome.attachments) {
    const identity = `${messageId.toLocaleLowerCase("und")}\0${attachment.attachmentId}`;
    if (input.seenAttachments.has(identity)) {
      await unlink(attachment.stagedPath).catch(() => undefined);
      input.unpublishedPaths.delete(attachment.stagedPath);
      continue;
    }
    input.seenAttachments.add(identity);
    const candidate: MailAttachmentCandidate = {
      messageId,
      attachmentId: attachment.attachmentId,
      stagedPath: attachment.stagedPath,
      originalName: attachment.originalName,
      mimeType: attachment.mimeType,
      size: attachment.size,
      sender: metadata.sender,
      receivedAt: metadata.receivedAt,
      emailContextMatches: input.outcome.emailContextMatches,
      emailReceiptMatches: input.outcome.emailReceiptMatches,
    };
    input.attachments.push(candidate);
    emit(input.options, {
      type: "attachment-staged",
      attachmentName: attachment.originalName,
      scannedMessages: input.scannedMessages,
      totalMessages: input.totalMessages,
      attachmentsStaged: input.attachments.length,
    });
    try {
      await input.options.onAttachment?.(candidate);
      input.unpublishedPaths.delete(attachment.stagedPath);
    } catch (error) {
      throw new AttachmentConsumerError(error);
    }
  }
}

class AttachmentConsumerError extends Error {
  constructor(readonly originalError: unknown) {
    super("The attachment consumer failed.", { cause: originalError });
  }
}

class ClientLeasePool {
  private readonly available: ImapClient[];
  private readonly waiters: Array<(client: ImapClient) => void> = [];
  private readonly healthy: Set<ImapClient>;

  constructor(clients: readonly ImapClient[]) {
    this.available = [...clients];
    this.healthy = new Set(clients);
  }

  get size(): number {
    return this.healthy.size;
  }

  add(client: ImapClient): void {
    if (this.healthy.has(client)) return;
    this.healthy.add(client);
    const waiter = this.waiters.shift();
    if (waiter) waiter(client);
    else this.available.push(client);
  }

  async acquire(): Promise<{
    client: ImapClient;
    release: () => void;
    discard: () => void;
  }> {
    const client = this.available.pop() ??
      await new Promise<ImapClient>((resolve) => this.waiters.push(resolve));
    let released = false;
    const finish = (discard: boolean): void => {
      if (released) return;
      released = true;
      if (discard) {
        this.healthy.delete(client);
        return;
      }
      const waiter = this.waiters.shift();
      if (waiter) waiter(client);
      else this.available.push(client);
    };
    return {
      client,
      release: () => finish(false),
      discard: () => finish(true),
    };
  }
}

function batches<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

/** Select received-mail folders, excluding special-use roots and descendants. */
export function selectReceivedMailboxes(
  mailboxes: readonly ImapMailbox[],
  provider: ImapConnectionProfile["provider"],
): ImapMailbox[] {
  const excludedRoots = mailboxes.filter((mailbox) =>
    mailboxIsExcludedRoot(mailbox),
  );
  const selectable = mailboxes.filter(
    (mailbox) => mailbox.selectable && !isWithinExcludedTree(mailbox, excludedRoots),
  );
  if (provider === "google") {
    const allMail = selectable.find((mailbox) =>
      mailboxIsAllMail(mailbox),
    );
    if (allMail) return [allMail];
  }
  return selectable;
}

function mailboxIsExcludedRoot(mailbox: ImapMailbox): boolean {
  if (EXCLUDED_SPECIAL_USES.has(normalizeSpecialUse(mailbox.specialUse))) return true;
  const leaf = conventionalMailboxLeaf(mailbox);
  return leaf !== undefined && EXCLUDED_CONVENTIONAL_NAMES.has(leaf);
}

function mailboxIsAllMail(mailbox: ImapMailbox): boolean {
  if (GMAIL_ALL_MAIL_SPECIAL_USES.has(normalizeSpecialUse(mailbox.specialUse))) return true;
  const leaf = conventionalMailboxLeaf(mailbox);
  return leaf !== undefined && ALL_MAIL_CONVENTIONAL_NAMES.has(leaf);
}

/** Only top-level names and bracketed provider namespaces are treated as conventional. */
function conventionalMailboxLeaf(mailbox: ImapMailbox): string | undefined {
  const delimiter = mailbox.delimiter || "/";
  const segments = mailbox.path
    .split(delimiter)
    .map((segment) => segment.trim().toLocaleLowerCase("en-US"))
    .filter(Boolean);
  if (segments.length === 1) return segments[0];
  if (segments.length === 2 && /^\[[^\]]+\]$/u.test(segments[0] ?? "")) {
    return segments[1];
  }
  return undefined;
}

function isWithinExcludedTree(mailbox: ImapMailbox, roots: readonly ImapMailbox[]): boolean {
  return roots.some((root) => {
    if (mailbox.path === root.path) return true;
    const delimiter = root.delimiter || mailbox.delimiter;
    return !!delimiter && mailbox.path.startsWith(`${root.path}${delimiter}`);
  });
}

function gmailMessageIsExcluded(
  profile: ImapConnectionProfile,
  metadata: ImapMessageMetadata,
): boolean {
  if (profile.provider !== "google" || !metadata.labels) return false;
  for (const label of metadata.labels) {
    if (EXCLUDED_SPECIAL_USES.has(normalizeSpecialUse(label))) return true;
  }
  return false;
}

async function searchReceivedMessages(
  client: ImapClient,
  profile: ImapConnectionProfile,
  options: ImapSearchOptions,
): Promise<readonly number[]> {
  const hasAttachmentsOnly = profile.provider === "google";
  try {
    return await client.searchReceived(options.startInclusive, options.endExclusive, {
      hasAttachmentsOnly,
    });
  } catch (error) {
    if (!hasAttachmentsOnly || !isMissingServerExtension(error)) throw error;
    return await client.searchReceived(options.startInclusive, options.endExclusive, {
      hasAttachmentsOnly: false,
    });
  }
}

function isMissingServerExtension(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "MissingServerExtension"
  );
}

function normalizeSpecialUse(value: string | undefined): string {
  return value?.trim().toLocaleLowerCase("en-US") ?? "";
}

function validateOptions(options: ImapSearchOptions): void {
  if (!options.accountEmail.trim()) {
    throw new MailSourceError("INVALID_REQUEST", "An account email address is required.");
  }
  if (
    Number.isNaN(options.startInclusive.getTime()) ||
    Number.isNaN(options.endExclusive.getTime()) ||
    options.startInclusive >= options.endExclusive
  ) {
    throw new MailSourceError("INVALID_REQUEST", "The IMAP search date range is invalid.");
  }
  if (!options.stagingDirectory.trim()) {
    throw new MailSourceError("INVALID_REQUEST", "A staging directory is required.");
  }
}

function validateProfile(profile: ImapConnectionProfile): void {
  if (!profile.host.trim() || !profile.username.trim() || !profile.email.trim()) {
    throw new MailSourceError("INVALID_REQUEST", "The IMAP account profile is incomplete.");
  }
  if (!Number.isInteger(profile.port) || profile.port < 1 || profile.port > 65_535) {
    throw new MailSourceError("INVALID_REQUEST", "The IMAP account port is invalid.");
  }
  if (profile.tls !== "implicit" && profile.tls !== "starttls") {
    throw new MailSourceError("INVALID_REQUEST", "IMAP requires implicit TLS or STARTTLS.");
  }
  if (profile.provider === "google" && profile.authentication.type !== "oauth2") {
    throw new MailSourceError("INVALID_REQUEST", "Google accounts require OAuth authentication.");
  }
  if (profile.provider === "imap" && profile.authentication.type !== "password") {
    throw new MailSourceError("INVALID_REQUEST", `${profile.provider} requires password authentication.`);
  }
  const secret =
    profile.authentication.type === "oauth2"
      ? profile.authentication.accessToken
      : profile.authentication.password;
  if (!secret) {
    throw new MailSourceError("INVALID_REQUEST", "The IMAP authentication credential is empty.");
  }
}

function enrichIssue(issue: MailIssue, mailbox: string, messageId: string): MailIssue {
  return {
    ...issue,
    mailbox: issue.mailbox ?? mailbox,
    messageId: issue.messageId ?? messageId,
  };
}

function emit(options: ImapSearchOptions, event: ImapProgressEvent): void {
  try {
    options.onProgress?.(event);
  } catch {
    // Human-facing progress must never interrupt collection.
  }
}

function accessError(prefix: string, error: unknown): MailSourceError {
  return new MailSourceError(
    "MAIL_ACCESS_FAILED",
    `${prefix}: ${errorMessage(error)}`,
    undefined,
    { cause: error },
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isTransportFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String(error.code).toUpperCase() : "";
  if (
    [
      "ECONNABORTED",
      "ECONNREFUSED",
      "ECONNRESET",
      "EHOSTUNREACH",
      "ENETDOWN",
      "ENETUNREACH",
      "EPIPE",
      "ETIMEDOUT",
    ].includes(code)
  ) {
    return true;
  }
  const responseStatus = "responseStatus" in error
    ? String(error.responseStatus).toUpperCase()
    : "";
  return responseStatus === "BYE";
}
