import { isPdfAttachment } from "./file-types.js";
import { matchesInvoiceKeyword } from "./keywords.js";
import { extractPdfText, type PdfTextExtraction } from "./pdf.js";

export type ClassificationReason =
  | "unsupported-type"
  | "filename-keyword"
  | "pdf-text-keyword"
  | "pdf-textless"
  | "pdf-unreadable"
  | "no-invoice-signal"
  | "email-context-keyword";

export interface AttachmentClassificationInput {
  originalName: string;
  stagedPath: string;
  mimeType?: string;
  emailContextMatches: boolean;
  emailReceiptMatches: boolean;
}

export interface AttachmentClassification {
  include: boolean;
  reason: ClassificationReason;
  partialFailure: boolean;
  warning?: string;
}

export interface ClassificationDependencies {
  extractPdfText?: (filePath: string) => Promise<PdfTextExtraction>;
}

/** Classify an attachment after it has been staged on disk. */
export async function classifyAttachment(
  input: AttachmentClassificationInput,
  dependencies: ClassificationDependencies = {},
): Promise<AttachmentClassification> {
  if (!isPdfAttachment(input.originalName, input.mimeType)) {
    return { include: false, reason: "unsupported-type", partialFailure: false };
  }

  if (matchesInvoiceKeyword(input.originalName)) {
    return { include: true, reason: "filename-keyword", partialFailure: false };
  }

  if (input.emailReceiptMatches) {
    return { include: true, reason: "email-context-keyword", partialFailure: false };
  }

  try {
    const extraction = await (dependencies.extractPdfText ?? extractPdfText)(input.stagedPath);
    if (!extraction.hasText) {
      return { include: true, reason: "pdf-textless", partialFailure: false };
    }
    if (matchesInvoiceKeyword(extraction.text)) {
      return { include: true, reason: "pdf-text-keyword", partialFailure: false };
    }
    return { include: false, reason: "no-invoice-signal", partialFailure: false };
  } catch {
    const fallback: AttachmentClassification = {
      include: true,
      reason: "pdf-unreadable",
      partialFailure: true,
      warning: `Could not inspect PDF attachment "${input.originalName}"; included conservatively.`,
    };
    return fallback;
  }
}
