import { mkdir, unlink } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { Readable } from "node:stream";

import {
  MailSourceError,
  type MailAttachmentCandidate,
  type MailIssue,
  type MailProgressEvent,
  type MailSource,
} from "../mail/types.js";
import { StreamingMailParserExtractor } from "../imap/mailparser-extractor.js";
import {
  runOrderedKeyedTasks,
  type OrderedTaskResult,
} from "../imap/ordered-worker-pool.js";
import type {
  ExtractedAttachment,
  MimeExtractionResult,
} from "../imap/types.js";
import { createDefaultGmailApiClient } from "./default-client.js";
import {
  buildGmailMessagePartPlan,
} from "./part-plan.js";
import { extractGmailMessageParts } from "./part-extractor.js";
import type {
  GmailApiConnectionProfile,
  GmailApiClient,
  GmailApiMessage,
  GmailApiProfileResolver,
  GmailMailSourceDependencies,
  GmailSearchOptions,
  GmailSearchResult,
} from "./types.js";

const GMAIL_HOST = "gmail.googleapis.com";
const LOGICAL_MAILBOX = "Google All Mail";
const DEFAULT_REQUEST_CONCURRENCY = 10;
const DEFAULT_WORKING_CHUNK_SIZE = 50;
const MAXIMUM_PENDING_RESULTS = 16;
const GMAIL_LIST_PAGE_SIZE = 500;
const EXCLUDED_LABELS = new Set(["SENT", "DRAFT", "SPAM", "TRASH"]);

interface MessageFetchSuccess {
  kind: "success";
  messageId: string;
  message: GmailApiMessage;
  receivedAt: Date | undefined;
}

interface MessageFetchFailure {
  kind: "error";
  messageId: string;
  error: unknown;
}

type MessageFetchResult = MessageFetchSuccess | MessageFetchFailure;

interface MessageOutcome {
  messageId?: string;
  normalizedMessageId?: string;
  message?: GmailApiMessage;
  receivedAt?: Date;
  sender?: string;
  attachments: ExtractedAttachment[];
  emailContextMatches: boolean;
  emailReceiptMatches: boolean;
  issues: MailIssue[];
  deduplicateFuture: boolean;
}

/** Retrieves Google mail through the Gmail REST API while preserving MailSource semantics. */
export class GmailApiMailSource implements MailSource {
  private readonly dependencies: GmailMailSourceDependencies;

  constructor(
    private readonly resolveProfile: GmailApiProfileResolver,
    dependencies: Partial<GmailMailSourceDependencies> = {},
  ) {
    this.dependencies = {
      clientFactory: dependencies.clientFactory ?? createDefaultGmailApiClient,
      mimeExtractor: dependencies.mimeExtractor ?? new StreamingMailParserExtractor(),
      requestConcurrency: normalizePositiveInteger(
        dependencies.requestConcurrency,
        DEFAULT_REQUEST_CONCURRENCY,
        "Gmail API request concurrency",
      ),
      workingChunkSize: normalizePositiveInteger(
        dependencies.workingChunkSize,
        DEFAULT_WORKING_CHUNK_SIZE,
        "Gmail API working chunk size",
      ),
    };
  }

  async search(options: GmailSearchOptions): Promise<GmailSearchResult> {
    validateOptions(options);
    const stagingDirectory = isAbsolute(options.stagingDirectory)
      ? options.stagingDirectory
      : resolve(options.stagingDirectory);
    await mkdir(stagingDirectory, { recursive: true });

    let profile: GmailApiConnectionProfile;
    try {
      profile = await this.resolveProfile(options.accountEmail.trim());
      validateProfile(profile, options.accountEmail);
    } catch (error) {
      if (error instanceof MailSourceError) throw error;
      throw accessError("The configured Google account could not be loaded", error);
    }

    emit(options, {
      type: "connection-started",
      provider: "google",
      host: GMAIL_HOST,
    });

    let client: Awaited<ReturnType<typeof this.dependencies.clientFactory>>;
    try {
      client = await this.dependencies.clientFactory(profile);
      const apiProfile = await client.getProfile();
      if (!sameEmail(apiProfile.emailAddress, profile.email)) {
        throw new Error(
          `Google authenticated ${apiProfile.emailAddress || "an unknown account"}, not ${profile.email}.`,
        );
      }
    } catch (error) {
      throw accessError(`Could not authenticate to ${GMAIL_HOST}`, error);
    }

    emit(options, {
      type: "authenticated",
      provider: "google",
      accountEmail: profile.email,
    });
    emit(options, { type: "account-selected", accountName: profile.email });

    let listedMessageIds: readonly string[];
    try {
      listedMessageIds = await listAllMessageIds(client, options);
    } catch (error) {
      if (error instanceof MailSourceError) throw error;
      throw accessError("The Gmail message list could not be read", error);
    }

    const totalMessages = listedMessageIds.length;
    const attachments: MailAttachmentCandidate[] = [];
    const issues: MailIssue[] = [];
    const seenMessages = new Set<string>();
    const seenAttachments = new Set<string>();
    const unpublishedPaths = new Set<string>();
    let scannedMessages = 0;

    emit(options, {
      type: "scan-started",
      scannedMessages,
      totalMessages,
      attachmentsStaged: attachments.length,
    });
    emit(options, {
      type: "mailbox-started",
      mailboxName: LOGICAL_MAILBOX,
      scannedMessages,
      totalMessages,
      attachmentsStaged: attachments.length,
    });

    try {
      const fetched = await this.fetchMessages(client, listedMessageIds);
      const tasks = [...fetched].sort(compareFetchedMessages);

      for (const chunk of batches(tasks, this.dependencies.workingChunkSize)) {
        await runOrderedKeyedTasks<MessageFetchResult, string, MessageOutcome>(chunk, {
          concurrency: this.dependencies.requestConcurrency,
          maximumPendingResults: Math.min(
            chunk.length || 1,
            Math.max(this.dependencies.requestConcurrency, MAXIMUM_PENDING_RESULTS),
          ),
          keyOf: messageTaskKey,
          run: async (task, context) => {
            if (task.kind === "error") throw task.error;
            if (!task.receivedAt) {
              throw new Error("Gmail returned an invalid or missing internalDate.");
            }
            if (!messageNeedsProcessing(task, task.receivedAt, options)) return emptyOutcome();

            const stableMessageId = messageHeader(task.message, "message-id")?.trim();
            const normalizedMessageId = normalizeMessageId(stableMessageId);
            if (
              (normalizedMessageId && seenMessages.has(normalizedMessageId)) ||
              previousDeduplicates(context.previous)
            ) {
              return deduplicatedOutcome(normalizedMessageId);
            }

            const outcome = await this.processMessage({
              client,
              task,
              stagingDirectory,
              options,
            });
            for (const attachment of outcome.attachments) {
              unpublishedPaths.add(attachment.stagedPath);
            }
            return outcome;
          },
          onOrderedResult: async (result) => {
            scannedMessages += 1;
            if (result.status === "rejected") {
              const messageId = displayMessageId(result.input);
              issues.push({
                code: "MESSAGE_READ_FAILED",
                message: `Could not download or parse message ${messageId}: ${errorMessage(result.reason)}`,
                mailbox: LOGICAL_MAILBOX,
                messageId,
              });
            } else {
              await publishOutcome({
                outcome: result.value,
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
      await cleanupPaths(unpublishedPaths);
      if (error instanceof AttachmentConsumerError) throw error.originalError;
      throw error;
    }

    emit(options, {
      type: "mailbox-completed",
      mailboxName: LOGICAL_MAILBOX,
      scannedMessages,
      totalMessages,
      attachmentsStaged: attachments.length,
    });
    emit(options, {
      type: "search-completed",
      scannedMessages,
      totalMessages,
      attachmentsStaged: attachments.length,
    });
    return { attachments, issues, scannedMessages };
  }

  private async fetchMessages(
    client: GmailApiClient,
    messageIds: readonly string[],
  ): Promise<MessageFetchResult[]> {
    const results: MessageFetchResult[] = [];
    for (const chunk of batches(messageIds, this.dependencies.workingChunkSize)) {
      results.push(...await mapConcurrent(chunk, this.dependencies.requestConcurrency, async (messageId) => {
        try {
          const message = await client.getMessage(messageId);
          if (message.id !== messageId) {
            throw new Error(
              `Gmail returned message ${message.id || "without an ID"} for requested ID ${messageId}.`,
            );
          }
          return {
            kind: "success" as const,
            messageId,
            message,
            receivedAt: parseInternalDate(message.internalDate),
          };
        } catch (error) {
          return { kind: "error" as const, messageId, error };
        }
      }));
    }
    return results;
  }

  private async processMessage(input: {
    client: GmailApiClient;
    task: MessageFetchSuccess;
    stagingDirectory: string;
    options: GmailSearchOptions;
  }): Promise<MessageOutcome> {
    const { message } = input.task;
    const stableMessageId = messageHeader(message, "message-id")?.trim();
    const messageId = stableMessageId || `gmail:${message.id || input.task.messageId}`;
    const subject = messageHeader(message, "subject") ?? "";
    const sender = messageHeader(message, "from") ?? "";
    let extracted: MimeExtractionResult;
    const partPlan = buildGmailMessagePartPlan(message.payload);

    if (partPlan) {
      const planned = await extractGmailMessageParts({
        client: input.client,
        messageId: input.task.messageId,
        partPlan,
        stagingDirectory: input.stagingDirectory,
        subject,
        keywords: input.options.keywords,
      });
      if (planned.kind === "success") {
        extracted = planned;
      } else {
        await Promise.all(planned.stagedPaths.map((file) => unlink(file).catch(() => undefined)));
        extracted = await this.extractRawMessage(input.client, input.task.messageId, {
          stagingDirectory: input.stagingDirectory,
          subject,
          keywords: input.options.keywords,
        });
      }
    } else {
      extracted = await this.extractRawMessage(input.client, input.task.messageId, {
        stagingDirectory: input.stagingDirectory,
        subject,
        keywords: input.options.keywords,
      });
    }

    const normalizedMessageId = normalizeMessageId(stableMessageId);
    return {
      messageId,
      ...(normalizedMessageId ? { normalizedMessageId } : {}),
      message,
      ...(input.task.receivedAt ? { receivedAt: input.task.receivedAt } : {}),
      sender,
      attachments: extracted.attachments,
      emailContextMatches: extracted.emailContextMatches,
      emailReceiptMatches: extracted.emailReceiptMatches,
      issues: extracted.issues.map((issue) => enrichIssue(issue, messageId)),
      deduplicateFuture: extracted.issues.length === 0,
    };
  }

  private async extractRawMessage(
    client: GmailApiClient,
    messageId: string,
    input: {
      stagingDirectory: string;
      subject: string;
      keywords: readonly string[];
    },
  ): Promise<MimeExtractionResult> {
    const encoded = await client.getRawMessage(messageId);
    const source = Readable.from(strictBase64UrlDecode(encoded));
    return this.dependencies.mimeExtractor.extract({ source, ...input });
  }
}

async function listAllMessageIds(
  client: Pick<GmailApiClient, "listMessages">,
  options: GmailSearchOptions,
): Promise<string[]> {
  const result: string[] = [];
  const seenIds = new Set<string>();
  const seenPageTokens = new Set<string>();
  const query = gmailSearchQuery(options.startInclusive, options.endExclusive);
  let pageToken: string | undefined;

  do {
    if (pageToken && seenPageTokens.has(pageToken)) {
      throw new MailSourceError(
        "MAIL_PROTOCOL_ERROR",
        "Gmail returned a repeated message-list page token.",
      );
    }
    if (pageToken) seenPageTokens.add(pageToken);
    const page = await client.listMessages({
      query,
      maxResults: GMAIL_LIST_PAGE_SIZE,
      ...(pageToken ? { pageToken } : {}),
    });
    for (const id of page.messageIds) {
      const normalized = id.trim();
      if (!normalized || seenIds.has(normalized)) continue;
      seenIds.add(normalized);
      result.push(normalized);
    }
    pageToken = page.nextPageToken?.trim() || undefined;
  } while (pageToken);

  return result;
}

export function gmailSearchQuery(startInclusive: Date, endExclusive: Date): string {
  // IMAP's widened window is SINCE(start - 1 day), which is inclusive.
  // Gmail's `after:` operator is exclusive, so move it back one additional
  // calendar day to cover the same interval. Exact internalDate filtering is
  // still applied locally after metadata retrieval.
  const after = shiftedLocalDate(startInclusive, -2);
  const before = shiftedLocalDate(endExclusive, 1);
  return `after:${formatGmailDate(after)} before:${formatGmailDate(before)} has:attachment`;
}

function shiftedLocalDate(value: Date, days: number): Date {
  const shifted = new Date(value);
  shifted.setDate(shifted.getDate() + days);
  return shifted;
}

function formatGmailDate(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}/${month}/${day}`;
}

function messageNeedsProcessing(
  task: MessageFetchSuccess,
  receivedAt: Date,
  options: GmailSearchOptions,
): boolean {
  return (
    receivedAt >= options.startInclusive &&
    receivedAt < options.endExclusive &&
    !task.message.labelIds.some((label) => EXCLUDED_LABELS.has(label.trim().toUpperCase()))
  );
}

function messageTaskKey(task: MessageFetchResult): string {
  if (task.kind === "error") return `\0gmail:${task.messageId}`;
  return normalizeMessageId(messageHeader(task.message, "message-id")) ||
    `\0gmail:${task.messageId}`;
}

function displayMessageId(task: MessageFetchResult): string {
  if (task.kind === "success") {
    return messageHeader(task.message, "message-id")?.trim() || `gmail:${task.messageId}`;
  }
  return `gmail:${task.messageId}`;
}

function compareFetchedMessages(left: MessageFetchResult, right: MessageFetchResult): number {
  const leftTime = left.kind === "success" ? left.receivedAt?.getTime() : undefined;
  const rightTime = right.kind === "success" ? right.receivedAt?.getTime() : undefined;
  if (leftTime !== undefined && rightTime !== undefined && leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  if (leftTime !== undefined && rightTime === undefined) return -1;
  if (leftTime === undefined && rightTime !== undefined) return 1;
  return left.messageId.localeCompare(right.messageId);
}

function parseInternalDate(value: string | undefined): Date | undefined {
  if (!value || !/^\d+$/u.test(value)) return undefined;
  const milliseconds = Number(value);
  if (!Number.isSafeInteger(milliseconds)) return undefined;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function messageHeader(message: GmailApiMessage, name: string): string | undefined {
  return message.payload?.headers.find(
    (header) => header.name.trim().toLocaleLowerCase("en-US") === name,
  )?.value;
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

function previousDeduplicates(
  previous: OrderedTaskResult<MessageFetchResult, string, MessageOutcome> | undefined,
): boolean {
  return previous?.status === "fulfilled" && previous.value.deduplicateFuture;
}

async function publishOutcome(input: {
  outcome: MessageOutcome;
  options: GmailSearchOptions;
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
  const messageId = input.outcome.messageId;
  const receivedAt = input.outcome.receivedAt;
  if (!messageId || !receivedAt) return;

  for (const attachment of input.outcome.attachments) {
    const identity = `${normalizeMessageId(messageId)}\0${attachment.attachmentId}`;
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
      sender: input.outcome.sender ?? "",
      receivedAt,
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

function strictBase64UrlDecode(value: string): Buffer {
  const encoded = value.trim();
  if (!encoded || !/^[A-Za-z0-9_-]+={0,2}$/u.test(encoded)) {
    throw new Error("Gmail returned malformed base64url message data.");
  }
  const unpadded = encoded.replace(/=+$/u, "");
  if (
    unpadded.length % 4 === 1 ||
    (encoded.includes("=") && encoded.length % 4 !== 0)
  ) {
    throw new Error("Gmail returned malformed base64url message data.");
  }
  const decoded = Buffer.from(unpadded, "base64url");
  if (decoded.toString("base64url") !== unpadded) {
    throw new Error("Gmail returned malformed base64url message data.");
  }
  return decoded;
}

async function mapConcurrent<T, U>(
  values: readonly T[],
  concurrency: number,
  map: (value: T, index: number) => Promise<U>,
): Promise<U[]> {
  const results = new Array<U>(values.length);
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        const value = values[index];
        if (value !== undefined) results[index] = await map(value, index);
      }
    }),
  );
  return results;
}

function batches<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function normalizePositiveInteger(
  value: number | undefined,
  defaultValue: number,
  name: string,
): number {
  if (value === undefined) return defaultValue;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
  return value;
}

function validateOptions(options: GmailSearchOptions): void {
  if (!options.accountEmail.trim()) {
    throw new MailSourceError("INVALID_REQUEST", "An account email address is required.");
  }
  if (
    Number.isNaN(options.startInclusive.getTime()) ||
    Number.isNaN(options.endExclusive.getTime()) ||
    options.startInclusive >= options.endExclusive
  ) {
    throw new MailSourceError("INVALID_REQUEST", "The Gmail search date range is invalid.");
  }
  if (!options.stagingDirectory.trim()) {
    throw new MailSourceError("INVALID_REQUEST", "A staging directory is required.");
  }
}

function validateProfile(profile: GmailApiConnectionProfile, requestedEmail: string): void {
  if (
    !profile.email.trim() ||
    !profile.accessToken.trim() ||
    !profile.tokenType.trim() ||
    !profile.scope.trim() ||
    !profile.oauthClient.clientId.trim()
  ) {
    throw new MailSourceError("INVALID_REQUEST", "The Google account profile is incomplete.");
  }
  if (!sameEmail(profile.email, requestedEmail)) {
    throw new MailSourceError(
      "INVALID_REQUEST",
      `The Google account profile is for ${profile.email}, not ${requestedEmail.trim()}.`,
    );
  }
  if (Number.isNaN(profile.expiresAt.getTime())) {
    throw new MailSourceError("INVALID_REQUEST", "The Google access-token expiry is invalid.");
  }
}

function enrichIssue(issue: MailIssue, messageId: string): MailIssue {
  return {
    ...issue,
    mailbox: issue.mailbox ?? LOGICAL_MAILBOX,
    messageId: issue.messageId ?? messageId,
  };
}

function normalizeMessageId(value: string | undefined): string | undefined {
  return value?.trim().toLocaleLowerCase("und") || undefined;
}

function sameEmail(left: string, right: string): boolean {
  return left.trim().toLocaleLowerCase("en-US") === right.trim().toLocaleLowerCase("en-US");
}

function emit(options: GmailSearchOptions, event: MailProgressEvent): void {
  try {
    options.onProgress?.(event);
  } catch {
    // Human-facing progress must never interrupt collection.
  }
}

async function cleanupPaths(paths: Set<string>): Promise<void> {
  await Promise.all([...paths].map((file) => unlink(file).catch(() => undefined)));
  paths.clear();
}

class AttachmentConsumerError extends Error {
  constructor(readonly originalError: unknown) {
    super("The attachment consumer failed.", { cause: originalError });
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
