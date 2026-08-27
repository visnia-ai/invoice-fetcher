import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { text } from "node:stream/consumers";

import { isPdfAttachment } from "../detection/file-types.js";
import {
  matchesInvoiceKeyword,
  matchesReceiptKeyword,
  normalizeSearchText,
} from "../detection/keywords.js";
import type {
  ExtractedAttachment,
  ImapClient,
  ImapMessagePartPlan,
  MimeExtractionResult,
} from "./types.js";

export interface PlannedPartExtractionRequest {
  client: ImapClient;
  uid: number;
  partPlan: ImapMessagePartPlan;
  stagingDirectory: string;
  subject: string;
  keywords: readonly string[];
}

export type PlannedPartExtractionResult =
  | {
      kind: "success";
      attachments: ExtractedAttachment[];
      emailContextMatches: boolean;
      emailReceiptMatches: boolean;
      issues: MimeExtractionResult["issues"];
    }
  | {
      kind: "fallback";
      reason: string;
      /** Paths are already unlinked when possible; callers may retry cleanup. */
      stagedPaths: readonly string[];
    };

/**
 * Download and stage only the BODYSTRUCTURE parts needed by classification.
 * The operation is transactional: any part error removes all files produced by
 * this attempt and asks the caller to use full-message MIME extraction.
 */
export async function extractPlannedMessageParts(
  request: PlannedPartExtractionRequest,
): Promise<PlannedPartExtractionResult> {
  const attachments: ExtractedAttachment[] = [];
  const stagedPaths: string[] = [];
  const emailContextMatches = matchesMessageKeyword(request.subject, request.keywords);
  let emailReceiptMatches = matchesReceiptKeyword(request.subject);

  try {
    for (const attachment of request.partPlan.attachments) {
      if (!isPdfAttachment(attachment.originalName, attachment.mimeType)) continue;
      if (!validPartId(attachment.part)) {
        throw new Error(`Invalid BODYSTRUCTURE part identifier ${attachment.part}.`);
      }
      const stagedPath = join(
        request.stagingDirectory,
        `${randomUUID()}-${sanitizeStagingBasename(attachment.originalName)}`,
      );
      stagedPaths.push(stagedPath);
      const downloaded = await request.client.downloadPart(request.uid, attachment.part);
      await pipeline(downloaded.content, createWriteStream(stagedPath));
      const file = await stat(stagedPath);
      attachments.push({
        attachmentId: attachment.attachmentId,
        stagedPath,
        originalName: attachment.originalName,
        mimeType: attachment.mimeType,
        size: file.size,
      });
    }

    const needsReceiptContext = attachments.some(
      (attachment) => !matchesInvoiceKeyword(attachment.originalName),
    );
    if (needsReceiptContext && !emailReceiptMatches) {
      for (const contextPart of request.partPlan.contextParts) {
        if (!validPartId(contextPart.part)) {
          throw new Error(`Invalid BODYSTRUCTURE part identifier ${contextPart.part}.`);
        }
        const downloaded = await request.client.downloadPart(request.uid, contextPart.part);
        if (matchesReceiptKeyword(await text(downloaded.content))) {
          emailReceiptMatches = true;
          break;
        }
      }
    }

    attachments.sort((left, right) => left.attachmentId.localeCompare(right.attachmentId));
    return {
      kind: "success",
      attachments,
      emailContextMatches,
      emailReceiptMatches,
      issues: [],
    };
  } catch (error) {
    await Promise.all(stagedPaths.map((path) => unlink(path).catch(() => undefined)));
    return {
      kind: "fallback",
      reason: errorMessage(error),
      stagedPaths,
    };
  }
}

/** Match exactly like the full-message extractor, including Unicode boundaries. */
export function matchesMessageKeyword(
  value: string,
  keywords: readonly string[],
): boolean {
  const normalized = normalizeSearchText(value);
  return keywords.some((keyword) => {
    const term = normalizeSearchText(keyword);
    if (!term) return false;
    if (/\p{Script=Han}/u.test(term)) return normalized.includes(term);
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "u").test(
      normalized,
    );
  });
}

function validPartId(value: string): boolean {
  return /^\d+(?:\.\d+)*$/u.test(value);
}

function sanitizeStagingBasename(filename: string): string {
  const sanitized = filename
    .replace(/[\u0000-\u001f\u007f]/gu, "_")
    .replace(/[\\/:]/gu, "_")
    .replace(/^\.+/u, "")
    .slice(0, 180);
  return sanitized || "attachment";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
