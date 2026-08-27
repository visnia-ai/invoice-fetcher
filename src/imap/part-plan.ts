import { basename } from "node:path";

import { isPdfAttachment } from "../detection/file-types.js";
import type {
  ImapAttachmentPart,
  ImapContextPart,
  ImapMessagePartPlan,
} from "./types.js";

interface BodyStructureNode {
  part?: unknown;
  type?: unknown;
  parameters?: unknown;
  id?: unknown;
  size?: unknown;
  disposition?: unknown;
  dispositionParameters?: unknown;
  childNodes?: unknown;
}

const PART_ID = /^\d+(?:\.\d+)*$/u;

/**
 * Convert ImapFlow's BODYSTRUCTURE value into the small, validated plan used by
 * the partial-download path. Undefined means the caller must use RFC822
 * extraction because the structure is not safe to address by part number.
 */
export function buildImapMessagePartPlan(
  bodyStructure: unknown,
): ImapMessagePartPlan | undefined {
  if (!isRecord(bodyStructure)) return undefined;

  const attachments: ImapAttachmentPart[] = [];
  const contextParts: ImapContextPart[] = [];
  const seenPartIds = new Set<string>();
  let attachmentOrdinal = 0;

  const walk = (value: unknown, derivedPart: string): boolean => {
    if (!isRecord(value)) return false;
    const node: BodyStructureNode = value;
    const mimeType = normalizedMimeType(node.type);
    if (!mimeType) return false;

    // Embedded messages reuse part numbers for their nested structure. Avoid
    // guessing at suffix rules; full MIME parsing is the safe path.
    if (mimeType === "message/rfc822") return false;

    const rawPart = node.part;
    if (rawPart !== undefined && (typeof rawPart !== "string" || !PART_ID.test(rawPart))) {
      return false;
    }
    const part = typeof rawPart === "string" ? rawPart : derivedPart || "1";
    if ((derivedPart && part !== derivedPart) || seenPartIds.has(part)) return false;

    const children = node.childNodes;
    if (mimeType.startsWith("multipart/")) {
      if (!Array.isArray(children) || children.length === 0) return false;
      if (derivedPart) seenPartIds.add(part);
      return children.every((child, index) =>
        walk(child, derivedPart ? `${derivedPart}.${index + 1}` : `${index + 1}`),
      );
    }
    if (children !== undefined) return false;

    seenPartIds.add(part);
    const disposition = normalizedToken(node.disposition);
    if (node.disposition !== undefined && disposition === undefined) return false;
    const dispositionName = parameter(
      node.dispositionParameters,
      "filename",
      "filename*",
    );
    const contentTypeName = parameter(node.parameters, "name", "name*");
    if (
      (node.dispositionParameters !== undefined &&
        !isStringRecord(node.dispositionParameters)) ||
      (node.parameters !== undefined && !isStringRecord(node.parameters))
    ) {
      return false;
    }

    const suppliedName = dispositionName ?? contentTypeName;
    const attachmentLike =
      disposition === "attachment" ||
      suppliedName !== undefined ||
      (!mimeType.startsWith("text/") && isPdfAttachment("", mimeType));

    if (attachmentLike) {
      attachmentOrdinal += 1;
      const originalName = safeDisplayName(suppliedName, attachmentOrdinal);
      if (isPdfAttachment(originalName, mimeType)) {
        const contentId = typeof node.id === "string" ? node.id.trim() : "";
        if (node.id !== undefined && typeof node.id !== "string") return false;
        attachments.push({
          part,
          attachmentId: contentId || `${attachmentOrdinal}:${originalName}`,
          originalName,
          mimeType,
          size: normalizedSize(node.size),
        });
      }
    } else if (mimeType === "text/plain" || mimeType === "text/html") {
      contextParts.push({ part, mimeType });
    }
    return true;
  };

  // ImapFlow addresses a single-part message as part 1, even though its parsed
  // root BODYSTRUCTURE normally omits the part property.
  if (!walk(bodyStructure, "")) return undefined;
  return { attachments, contextParts };
}

function normalizedMimeType(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const mimeType = value.split(";", 1)[0]?.trim().toLowerCase();
  return mimeType && /^[^\s/]+\/[^\s/]+$/u.test(mimeType) ? mimeType : undefined;
}

function normalizedToken(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized || undefined;
}

function normalizedSize(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function parameter(
  value: unknown,
  ...names: readonly string[]
): string | undefined {
  if (!isStringRecord(value)) return undefined;
  const wanted = new Set(names);
  for (const [key, candidate] of Object.entries(value)) {
    if (wanted.has(key.toLowerCase()) && candidate.trim()) return candidate.trim();
  }
  return undefined;
}

function safeDisplayName(filename: string | undefined, ordinal: number): string {
  const normalized = filename?.normalize("NFKC").trim().replaceAll("\\", "/");
  const name = basename(normalized || `attachment-${ordinal}`);
  return name || `attachment-${ordinal}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) && Object.values(value).every((item) => typeof item === "string")
  );
}
