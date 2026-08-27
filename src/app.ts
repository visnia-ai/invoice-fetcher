import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { AsyncBoundedQueue } from "./async-bounded-queue.js";
import { classifyAttachment, INVOICE_KEYWORDS } from "./detection/index.js";
import {
  type MailAttachmentCandidate,
  type MailProgressEvent,
  type MailSearchResult,
  type MailSource,
} from "./mail/index.js";
import { organizeInvoice } from "./organizer.js";
import { ProgressDisplay } from "./progress.js";
import { requireSupportedPlatform } from "./platform.js";
import { getDefaultRuntimeServices } from "./runtime.js";
import type { CliOptions, RunSummary } from "./types.js";

interface OutputWriter {
  write(chunk: string): unknown;
  readonly isTTY?: boolean;
  readonly columns?: number;
}

type IntervalHandle = unknown;

export interface ApplicationDependencies {
  mailSource: MailSource;
  stdout: OutputWriter;
  stderr: OutputWriter;
  platform: NodeJS.Platform;
  createStagingDirectory: () => Promise<string>;
  removeStagingDirectory: (directory: string) => Promise<void>;
  scheduleInterval: (callback: () => void, milliseconds: number) => IntervalHandle;
  cancelInterval: (handle: IntervalHandle) => void;
  now: () => number;
}

const defaultDependencies: ApplicationDependencies = {
  mailSource: getDefaultRuntimeServices().mailSource,
  stdout: process.stdout,
  stderr: process.stderr,
  platform: process.platform,
  createStagingDirectory: () => mkdtemp(path.join(os.tmpdir(), "invoice-fetcher-")),
  removeStagingDirectory: (directory) => rm(directory, { recursive: true, force: true }),
  scheduleInterval: (callback, milliseconds) => {
    const handle = setInterval(callback, milliseconds);
    handle.unref();
    return handle;
  },
  cancelInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  now: () => Date.now(),
};

export async function runApplication(
  options: CliOptions,
  dependencies: ApplicationDependencies = defaultDependencies,
): Promise<RunSummary> {
  requireSupportedPlatform(dependencies.platform);

  await mkdir(options.destination, { recursive: true });
  const stagingDirectory = await dependencies.createStagingDirectory();
  const progressDisplay = new ProgressDisplay(dependencies.stdout, {
    now: dependencies.now,
  });
  let closeAttachmentQueue = (): void => undefined;
  let attachmentDrain: Promise<void> = Promise.resolve();
  let cleanupStarted: Promise<void> | undefined;
  const cleanup = (): Promise<void> => {
    cleanupStarted ??= (async () => {
      closeAttachmentQueue();
      await attachmentDrain;
      progressDisplay.close();
      await dependencies.removeStagingDirectory(stagingDirectory);
    })();
    return cleanupStarted;
  };
  const sigintHandler = (): void => {
    process.removeListener("SIGINT", sigintHandler);
    void cleanup().finally(() => process.kill(process.pid, "SIGINT"));
  };
  process.once("SIGINT", sigintHandler);

  try {
    const latestProgress = {
      scannedMessages: 0,
      totalMessages: 0,
      attachmentsStaged: 0,
    };
    const writeProgress = (message: string): void => {
      progressDisplay.status(message);
    };
    const onProgress = (event: MailProgressEvent): void => {
      if ("scannedMessages" in event) {
        latestProgress.scannedMessages = event.scannedMessages;
        latestProgress.totalMessages = event.totalMessages;
        latestProgress.attachmentsStaged = event.attachmentsStaged;
        progressDisplay.updateMail(
          event.scannedMessages,
          event.totalMessages,
          event.attachmentsStaged,
        );
      }
      if (
        event.type === "attachment-staged" ||
        event.type === "messages-scanned" ||
        event.type === "search-completed" ||
        event.type === "scan-started"
      ) {
        return;
      }
      writeProgress(formatMailProgress(event));
    };

    dependencies.stdout.write(
      `Searching ${options.inboxEmail} from ${options.startDate} through ${options.endDate}…\n`,
    );

    const summary: RunSummary = {
      exitCode: 0,
      scanned: 0,
      copied: 0,
      deduplicated: 0,
      rejected: 0,
      failed: 0,
    };
    const streamedAttachmentIds = new Set<string>();
    const attachmentQueue = new AsyncBoundedQueue<MailAttachmentCandidate>(6);
    closeAttachmentQueue = () => attachmentQueue.close();

    const processAttachment = async (attachment: MailAttachmentCandidate): Promise<void> => {
      if (!isInsideDirectory(stagingDirectory, attachment.stagedPath)) {
        summary.failed += 1;
        dependencies.stderr.write(
          `Warning: ignored an unsafe staged path for ${attachment.originalName}.\n`,
        );
        return;
      }

      try {
        const classificationInput = {
          originalName: attachment.originalName,
          stagedPath: attachment.stagedPath,
          mimeType: attachment.mimeType,
          emailContextMatches: attachment.emailContextMatches,
          emailReceiptMatches: attachment.emailReceiptMatches,
        };
        const classification = await classifyAttachment(classificationInput);
        if (classification.warning) {
          dependencies.stderr.write(`Warning: ${classification.warning}\n`);
        }
        if (classification.partialFailure) summary.failed += 1;
        if (!classification.include) {
          summary.rejected += 1;
          return;
        }

        const result = await organizeInvoice({
          stagedPath: attachment.stagedPath,
          originalName: attachment.originalName,
          sender: attachment.sender,
          receivedAt: attachment.receivedAt,
          destinationRoot: options.destination,
          spansMultipleMonths: options.spansMultipleMonths,
        });
        if (result.status === "copied") {
          summary.copied += 1;
          dependencies.stdout.write(`Copied: ${result.destinationPath}\n`);
        } else {
          summary.deduplicated += 1;
        }
      } catch (error) {
        summary.failed += 1;
        dependencies.stderr.write(
          `Warning: failed to process ${attachment.originalName}: ${errorMessage(error)}\n`,
        );
      }
    };

    attachmentDrain = (async () => {
      for (;;) {
        const attachment = await attachmentQueue.dequeue();
        if (!attachment) return;
        await processAttachment(attachment);
      }
    })();

    const enqueueAttachment = async (attachment: MailAttachmentCandidate): Promise<void> => {
      const identity = attachmentIdentity(attachment);
      if (streamedAttachmentIds.has(identity)) return;
      streamedAttachmentIds.add(identity);
      try {
        await attachmentQueue.enqueue(attachment);
      } catch (error) {
        streamedAttachmentIds.delete(identity);
        throw error;
      }
    };

    const heartbeat = dependencies.scheduleInterval(() => {
      progressDisplay.refresh();
    }, 15_000);

    let search: MailSearchResult;
    try {
      try {
        search = await dependencies.mailSource.search({
          accountEmail: options.inboxEmail,
          startInclusive: options.startInclusive,
          endExclusive: options.endExclusive,
          stagingDirectory,
          keywords: INVOICE_KEYWORDS,
          onProgress,
          onAttachment: enqueueAttachment,
        });
      } finally {
        dependencies.cancelInterval(heartbeat);
      }
      progressDisplay.completeMail(
        search.scannedMessages,
        latestProgress.totalMessages || search.scannedMessages,
        search.attachments.length,
      );
      writeProgress(
        `Mail search complete: ${search.scannedMessages} messages scanned, ` +
          `${search.attachments.length} candidate attachments staged.`,
      );

      for (const attachment of search.attachments) {
        await enqueueAttachment(attachment);
      }
    } finally {
      closeAttachmentQueue();
      await attachmentDrain;
    }

    summary.scanned = search.scannedMessages;
    summary.failed += search.issues.length;

    for (const issue of search.issues) {
      const attachment = issue.attachmentName ? ` (${issue.attachmentName})` : "";
      dependencies.stderr.write(`Warning: ${issue.code}${attachment}: ${issue.message}\n`);
    }

    summary.exitCode = summary.failed > 0 ? 2 : 0;
    dependencies.stdout.write(
      `Summary: ${summary.scanned} messages scanned, ${summary.copied} copied, ` +
        `${summary.deduplicated} duplicates skipped, ${summary.rejected} rejected, ` +
        `${summary.failed} failed.\n`,
    );
    return summary;
  } finally {
    process.removeListener("SIGINT", sigintHandler);
    await cleanup();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function attachmentIdentity(attachment: MailAttachmentCandidate): string {
  return `${attachment.messageId.length}:${attachment.messageId}${attachment.attachmentId}`;
}

function isInsideDirectory(directory: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(directory), path.resolve(candidate));
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function formatMailProgress(event: MailProgressEvent): string {
  switch (event.type) {
    case "account-selected":
      return `selected account “${event.accountName}”.`;
    case "connection-started":
      return `connecting to ${event.host} (${event.provider})…`;
    case "authenticated":
      return `authenticated ${event.accountEmail} with ${event.provider}.`;
    case "scan-started":
      return `found ${event.totalMessages} messages to scan.`;
    case "mailbox-started":
      return (
        `scanning mailbox “${event.mailboxName}” ` +
        `(${event.scannedMessages} messages scanned, ` +
        `${event.attachmentsStaged} attachments staged)…`
      );
    case "mailbox-completed":
      return (
        `finished mailbox “${event.mailboxName}” ` +
        `(${event.scannedMessages} messages scanned, ` +
        `${event.attachmentsStaged} attachments staged).`
      );
    case "messages-scanned":
      return (
        `${event.scannedMessages} messages scanned; ` +
        `${event.attachmentsStaged} attachments staged.`
      );
    case "attachment-staged":
      return (
        `staged attachment ${event.attachmentsStaged}: ${event.attachmentName} ` +
        `(${event.scannedMessages} messages scanned).`
      );
    case "search-completed":
      return (
        `server search finished (${event.scannedMessages} messages scanned, ` +
        `${event.attachmentsStaged} attachments staged).`
      );
  }
}
