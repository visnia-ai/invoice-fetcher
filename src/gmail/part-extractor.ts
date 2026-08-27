import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { TextDecoder } from "node:util";

import { isPdfAttachment } from "../detection/file-types.js";
import {
  matchesInvoiceKeyword,
  matchesReceiptKeyword,
} from "../detection/keywords.js";
import { matchesMessageKeyword } from "../imap/part-extractor.js";
import type {
  ExtractedAttachment,
  MimeExtractionResult,
} from "../imap/types.js";
import type {
  GmailApiClient,
  GmailContextPart,
  GmailMessagePartPlan,
} from "./types.js";

const PART_ID = /^\d+(?:\.\d+)*$/u;

export interface GmailPartExtractionRequest {
  client: GmailApiClient;
  messageId: string;
  partPlan: GmailMessagePartPlan;
  stagingDirectory: string;
  subject: string;
  keywords: readonly string[];
}

export type GmailPartExtractionResult =
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

/** Stage a Gmail payload plan transactionally, falling back to raw MIME on any error. */
export async function extractGmailMessageParts(
  request: GmailPartExtractionRequest,
): Promise<GmailPartExtractionResult> {
  const attachments: ExtractedAttachment[] = [];
  const stagedPaths: string[] = [];
  const emailContextMatches = matchesMessageKeyword(request.subject, request.keywords);
  let emailReceiptMatches = matchesReceiptKeyword(request.subject);

  try {
    for (const attachment of request.partPlan.attachments) {
      if (!isPdfAttachment(attachment.originalName, attachment.mimeType)) continue;
      validatePartId(attachment.partId);
      const stagedPath = join(
        request.stagingDirectory,
        `${randomUUID()}-${sanitizeStagingBasename(attachment.originalName)}`,
      );
      stagedPaths.push(stagedPath);
      const content = await loadPartBytes(request, attachment);
      await pipeline(Readable.from(content), createWriteStream(stagedPath));
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
        validatePartId(contextPart.partId);
        const content = await loadPartBytes(request, contextPart);
        if (matchesReceiptKeyword(decodeContextPart(content, contextPart))) {
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
    return { kind: "fallback", reason: errorMessage(error), stagedPaths };
  }
}

type DownloadablePart = {
  inlineData?: string;
  externalAttachmentId?: string;
};

async function loadPartBytes(
  request: Pick<GmailPartExtractionRequest, "client" | "messageId">,
  part: DownloadablePart,
): Promise<Buffer> {
  if (part.inlineData !== undefined && part.externalAttachmentId !== undefined) {
    throw new Error("Gmail MIME part has multiple content sources.");
  }
  if (part.inlineData !== undefined) return decodeBase64Url(part.inlineData);
  if (part.externalAttachmentId !== undefined) {
    const response = await request.client.getAttachment(
      request.messageId,
      part.externalAttachmentId,
    );
    if (!response || typeof response.data !== "string") {
      throw new Error("Gmail attachment response is missing encoded data.");
    }
    return decodeBase64Url(response.data);
  }
  throw new Error("Gmail MIME part has no inline data or attachment identifier.");
}

function decodeBase64Url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]*={0,2}$/u.test(value)) {
    throw new Error("Gmail MIME part contains invalid base64url data.");
  }
  const paddingAt = value.indexOf("=");
  const core = paddingAt < 0 ? value : value.slice(0, paddingAt);
  const padding = paddingAt < 0 ? "" : value.slice(paddingAt);
  if (core.length % 4 === 1 || (padding && value.length % 4 !== 0)) {
    throw new Error("Gmail MIME part contains invalid base64url data.");
  }
  const decoded = Buffer.from(core, "base64url");
  if (decoded.toString("base64url") !== core) {
    throw new Error("Gmail MIME part contains invalid base64url data.");
  }
  return decoded;
}

function decodeContextPart(content: Buffer, part: GmailContextPart): string {
  let decoded = part.flowed ? decodeFlowed(content, part.delSp === true) : content;
  const charset = part.charset?.trim();
  if (charset && !/^(?:ascii|us-?ascii|utf-?8)$/iu.test(charset)) {
    try {
      decoded = Buffer.from(new TextDecoder(charset).decode(decoded), "utf8");
    } catch {
      // Unknown charsets retain their original bytes, matching the IMAP path.
    }
  }
  return decoded.toString("utf8");
}

function decodeFlowed(content: Buffer, delSp: boolean): Buffer {
  const lines = content.toString("latin1").split(/\r?\n/u);
  const result: string[] = [];
  let buffer: string | undefined;
  for (const line of lines) {
    if (buffer !== undefined && buffer.endsWith(" ") && !/(^|\n)-- $/u.test(buffer)) {
      buffer = delSp ? `${buffer.slice(0, -1)}${line}` : `${buffer}${line}`;
    } else {
      if (buffer !== undefined) result.push(buffer);
      buffer = line;
    }
  }
  if (buffer) result.push(buffer);
  return Buffer.from(result.join("\n").replace(/^ /gmu, ""), "latin1");
}

function validatePartId(value: string): void {
  if (!PART_ID.test(value)) throw new Error(`Invalid Gmail MIME part identifier ${value}.`);
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
