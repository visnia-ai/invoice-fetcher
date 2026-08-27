import { basename } from "node:path";

import { isPdfAttachment } from "../detection/file-types.js";
import type {
  GmailAttachmentPart,
  GmailContextPart,
  GmailMessagePartPlan,
} from "./types.js";

const PART_ID = /^\d+(?:\.\d+)*$/u;

/**
 * Normalize Gmail's MIME payload into a validated selective-download plan.
 * Undefined asks the caller to retry the message through its raw RFC822 body.
 */
export function buildGmailMessagePartPlan(
  payload: unknown,
): GmailMessagePartPlan | undefined {
  if (!isRecord(payload)) return undefined;

  const attachments: GmailAttachmentPart[] = [];
  const contextParts: GmailContextPart[] = [];
  const seenPartIds = new Set<string>();
  let attachmentOrdinal = 0;

  const walk = (value: unknown, derivedPartId: string, isRoot: boolean): boolean => {
    if (!isRecord(value)) return false;
    const mimeType = normalizedMimeType(value.mimeType);
    if (!mimeType || mimeType === "message/rfc822") return false;

    if (!Array.isArray(value.headers) || !Array.isArray(value.parts)) return false;
    if (!value.headers.every(isHeader)) return false;
    const headers = value.headers;

    if (
      value.partId !== undefined &&
      (typeof value.partId !== "string" ||
        (value.partId !== "" && !PART_ID.test(value.partId)))
    ) {
      return false;
    }
    const suppliedPartId = typeof value.partId === "string" ? value.partId : "";
    const partId = suppliedPartId || derivedPartId;
    if (!partId || !PART_ID.test(partId)) return false;
    // Gmail leaves the multipart root unaddressed and numbers its first child
    // `0`, so the synthesized root identifier must not reserve that value.
    const addressablePart = !(isRoot && mimeType.startsWith("multipart/"));
    if (addressablePart && seenPartIds.has(partId)) return false;
    if (addressablePart) seenPartIds.add(partId);

    if (value.filename !== undefined && typeof value.filename !== "string") return false;
    const filename = optionalString(value.filename);
    const disposition = parseDisposition(headerValue(headers, "content-disposition"));
    if (disposition === false) return false;
    const contentIdValue = headerValue(headers, "content-id");
    if (contentIdValue === false) return false;

    if (mimeType.startsWith("multipart/")) {
      if (value.parts.length === 0 || filename || disposition === "attachment") {
        return false;
      }
      return value.parts.every((child, index) =>
        walk(child, `${partId}.${index + 1}`, false),
      );
    }
    if (value.parts.length !== 0 || !isRecord(value.body)) return false;

    const body = normalizedBody(value.body);
    if (!body) return false;
    const attachmentLike =
      disposition === "attachment" ||
      filename !== undefined ||
      (!mimeType.startsWith("text/") && isPdfAttachment("", mimeType));

    if (attachmentLike) {
      attachmentOrdinal += 1;
      const originalName = safeDisplayName(filename, attachmentOrdinal);
      if (isPdfAttachment(originalName, mimeType)) {
        attachments.push({
          partId,
          attachmentId:
            (typeof contentIdValue === "string" && contentIdValue.trim()) ||
            `${attachmentOrdinal}:${originalName}`,
          originalName,
          mimeType,
          size: body.size,
          ...(body.data !== undefined ? { inlineData: body.data } : {}),
          ...(body.attachmentId !== undefined
            ? { externalAttachmentId: body.attachmentId }
            : {}),
        });
      }
    } else if (mimeType === "text/plain" || mimeType === "text/html") {
      const contentType = headerValue(headers, "content-type");
      if (contentType === false) return false;
      const parameters = parseContentTypeParameters(contentType);
      if (!parameters) return false;
      contextParts.push({
        partId,
        mimeType,
        ...(body.data !== undefined ? { inlineData: body.data } : {}),
        ...(body.attachmentId !== undefined
          ? { externalAttachmentId: body.attachmentId }
          : {}),
        ...(parameters.charset ? { charset: parameters.charset } : {}),
        ...(parameters.flowed ? { flowed: true } : {}),
        ...(parameters.delSp ? { delSp: true } : {}),
      });
    }
    return true;
  };

  // Gmail commonly leaves the root partId empty. Use 0 as a stable local ID;
  // child part IDs remain their Gmail-provided dotted identifiers.
  if (!walk(payload, "0", true)) return undefined;
  return { attachments, contextParts };
}

interface NormalizedBody {
  size: number | null;
  data?: string;
  attachmentId?: string;
}

function normalizedBody(value: Record<string, unknown>): NormalizedBody | undefined {
  if (
    value.size !== undefined &&
    (typeof value.size !== "number" ||
      !Number.isSafeInteger(value.size) ||
      value.size < 0)
  ) {
    return undefined;
  }
  if (value.data !== undefined && typeof value.data !== "string") return undefined;
  if (
    value.attachmentId !== undefined &&
    (typeof value.attachmentId !== "string" || !value.attachmentId.trim())
  ) {
    return undefined;
  }
  if (value.data !== undefined && value.attachmentId !== undefined) return undefined;
  return {
    size: typeof value.size === "number" ? value.size : null,
    ...(typeof value.data === "string" ? { data: value.data } : {}),
    ...(typeof value.attachmentId === "string"
      ? { attachmentId: value.attachmentId }
      : {}),
  };
}

function normalizedMimeType(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const mimeType = value.split(";", 1)[0]?.trim().toLowerCase();
  return mimeType && /^[^\s/]+\/[^\s/]+$/u.test(mimeType) ? mimeType : undefined;
}

function parseDisposition(
  value: string | undefined | false,
): string | undefined | false {
  if (value === false) return false;
  if (value === undefined) return undefined;
  const token = value.split(";", 1)[0]?.trim().toLowerCase();
  return token || false;
}

function parseContentTypeParameters(
  value: string | undefined,
): { charset?: string; flowed: boolean; delSp: boolean } | undefined {
  if (!value) return { flowed: false, delSp: false };
  const parameters = new Map<string, string>();
  for (const section of value.split(";").slice(1)) {
    const match = /^\s*([^=\s]+)\s*=\s*(?:"([^"]*)"|([^\s]*))\s*$/u.exec(section);
    if (!match) return undefined;
    const name = match[1]?.toLowerCase();
    const parameterValue = match[2] ?? match[3] ?? "";
    if (!name || parameters.has(name)) return undefined;
    parameters.set(name, parameterValue);
  }
  const charset = parameters.get("charset")?.trim();
  return {
    ...(charset ? { charset } : {}),
    flowed: parameters.get("format")?.toLowerCase() === "flowed",
    delSp: parameters.get("delsp")?.toLowerCase() === "yes",
  };
}

function headerValue(
  headers: readonly { name: string; value: string }[],
  name: string,
): string | undefined | false {
  const matches = headers.filter(
    (header) => header.name.trim().toLowerCase() === name,
  );
  if (matches.length > 1) return false;
  const value = matches[0]?.value.trim();
  return value || undefined;
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

function safeDisplayName(filename: string | undefined, ordinal: number): string {
  const normalized = filename?.normalize("NFKC").trim().replaceAll("\\", "/");
  const name = basename(normalized || `attachment-${ordinal}`);
  return name || `attachment-${ordinal}`;
}

function isHeader(value: unknown): value is { name: string; value: string } {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.value === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
