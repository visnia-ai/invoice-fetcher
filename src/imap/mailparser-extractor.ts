import { createWriteStream } from "node:fs";
import { stat, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { finished, pipeline } from "node:stream/promises";

import { isPdfAttachment } from "../detection/file-types.js";
import {
  matchesReceiptKeyword,
  normalizeSearchText,
} from "../detection/keywords.js";
import type {
  ExtractedAttachment,
  MimeExtractionRequest,
  MimeExtractionResult,
  MimeExtractor,
} from "./types.js";

interface MailParserAttachmentNode {
  type: "attachment";
  filename?: string;
  contentType?: string;
  contentId?: string;
  size?: number;
  content: NodeJS.ReadableStream;
  release(): void;
}

interface MailParserTextNode {
  type: "text";
  text?: string;
  html?: string | false;
}

type MailParserNode = MailParserAttachmentNode | MailParserTextNode;

interface MailParserLike extends NodeJS.WritableStream {
  on(event: "data", listener: (node: MailParserNode) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
}

type MailParserConstructor = new (options?: Record<string, unknown>) => MailParserLike;
type MailParserLoader = () => Promise<MailParserConstructor>;

const loadMailParser: MailParserLoader = async () => {
  // Keep this module typecheckable before the optional runtime dependency is installed.
  const moduleName: string = "mailparser";
  const imported = (await import(moduleName)) as { MailParser: MailParserConstructor };
  return imported.MailParser;
};

/** Streaming MIME extraction which never persists message bodies. */
export class StreamingMailParserExtractor implements MimeExtractor {
  constructor(private readonly loader: MailParserLoader = loadMailParser) {}

  async extract(request: MimeExtractionRequest): Promise<MimeExtractionResult> {
    const Parser = await this.loader();
    const parser = new Parser({ skipHtmlToText: true, skipTextToHtml: true });
    const attachments: ExtractedAttachment[] = [];
    const issues: MimeExtractionResult["issues"] = [];
    const writes: Promise<void>[] = [];
    let attachmentOrdinal = 0;
    let contextMatches = matchesAnyKeyword(request.subject, request.keywords);
    let receiptMatches = matchesReceiptKeyword(request.subject);

    parser.on("data", (node) => {
      if (node.type === "text") {
        const context = `${node.text ?? ""}\n${typeof node.html === "string" ? node.html : ""}`;
        contextMatches ||= matchesAnyKeyword(context, request.keywords);
        receiptMatches ||= matchesReceiptKeyword(context);
        return;
      }

      attachmentOrdinal += 1;
      const ordinal = attachmentOrdinal;
      const originalName = safeDisplayName(node.filename, ordinal);
      const mimeType = node.contentType ?? "application/octet-stream";
      if (!isPdfAttachment(originalName, mimeType)) {
        const discard = finished(node.content)
          .catch(() => undefined)
          .finally(() => node.release());
        writes.push(discard);
        node.content.resume();
        return;
      }

      const stagedPath = join(
        request.stagingDirectory,
        `${randomUUID()}-${sanitizeStagingBasename(originalName)}`,
      );
      const write = pipeline(node.content, createWriteStream(stagedPath))
        .then(async () => {
          const file = await stat(stagedPath);
          attachments.push({
            attachmentId: node.contentId?.trim() || `${ordinal}:${originalName}`,
            stagedPath,
            originalName,
            mimeType,
            size: Number.isSafeInteger(node.size) ? (node.size ?? null) : file.size,
          });
        })
        .catch(async (error: unknown) => {
          await unlink(stagedPath).catch(() => undefined);
          issues.push({
            code: "ATTACHMENT_SAVE_FAILED",
            message: `Could not stage attachment ${originalName}: ${errorMessage(error)}`,
            attachmentName: originalName,
          });
        })
        .finally(() => node.release());
      writes.push(write);
    });

    await pipeline(request.source, parser);
    await Promise.all(writes);
    attachments.sort((left, right) => left.attachmentId.localeCompare(right.attachmentId));
    return {
      attachments,
      emailContextMatches: contextMatches,
      emailReceiptMatches: receiptMatches,
      issues,
    };
  }
}

function matchesAnyKeyword(value: string, keywords: readonly string[]): boolean {
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

function safeDisplayName(filename: string | undefined, ordinal: number): string {
  const name = basename(filename?.normalize("NFKC").trim() || `attachment-${ordinal}`);
  return name || `attachment-${ordinal}`;
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
