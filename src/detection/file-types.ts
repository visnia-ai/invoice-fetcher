import path from "node:path";

export type EligibleAttachmentKind = "pdf" | "document" | "image";

const ARCHIVE_EXTENSIONS = new Set([
  ".7z",
  ".bz2",
  ".cab",
  ".gz",
  ".rar",
  ".tar",
  ".tgz",
  ".xz",
  ".zip",
]);

const PDF_EXTENSIONS = new Set([".pdf"]);
const DOCUMENT_EXTENSIONS = new Set([
  // Word
  ".doc",
  ".docm",
  ".docx",
  ".dot",
  ".dotm",
  ".dotx",
  // Spreadsheets
  ".xls",
  ".xlsb",
  ".xlsm",
  ".xlsx",
  ".xlt",
  ".xltm",
  ".xltx",
  // OpenDocument
  ".odf",
  ".odg",
  ".odp",
  ".ods",
  ".odt",
  ".otg",
  ".otp",
  ".ots",
  ".ott",
  // Plain/structured documents
  ".csv",
  ".rtf",
  ".txt",
  ".xml",
]);
const IMAGE_EXTENSIONS = new Set([
  ".heic",
  ".heif",
  ".jpeg",
  ".jpg",
  ".png",
  ".tif",
  ".tiff",
  ".webp",
]);

const PDF_MIME_TYPES = new Set(["application/pdf"]);
const DOCUMENT_MIME_TYPES = new Set([
  "application/msword",
  "application/rtf",
  "application/vnd.ms-excel",
  "application/vnd.ms-excel.sheet.binary.macroenabled.12",
  "application/vnd.ms-excel.sheet.macroenabled.12",
  "application/vnd.oasis.opendocument.formula",
  "application/vnd.oasis.opendocument.graphics",
  "application/vnd.oasis.opendocument.presentation",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.template",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
  "application/xml",
  "text/csv",
  "text/plain",
  "text/rtf",
  "text/xml",
]);
const IMAGE_MIME_TYPES = new Set([
  "image/heic",
  "image/heif",
  "image/jpeg",
  "image/png",
  "image/tiff",
  "image/webp",
]);

function normalizedMimeType(mimeType?: string): string {
  return mimeType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

/** Determine a supported attachment category from its filename, then MIME type. */
export function getEligibleAttachmentKind(
  filename: string,
  mimeType?: string,
): EligibleAttachmentKind | undefined {
  const extension = path.extname(filename).toLowerCase();

  // An explicit archive filename is never eligible, even with a misleading MIME type.
  if (ARCHIVE_EXTENSIONS.has(extension)) return undefined;
  if (PDF_EXTENSIONS.has(extension)) return "pdf";
  if (DOCUMENT_EXTENSIONS.has(extension)) return "document";
  if (IMAGE_EXTENSIONS.has(extension)) return "image";

  const mime = normalizedMimeType(mimeType);
  if (PDF_MIME_TYPES.has(mime)) return "pdf";
  if (DOCUMENT_MIME_TYPES.has(mime)) return "document";
  if (IMAGE_MIME_TYPES.has(mime)) return "image";
  return undefined;
}

export function isEligibleAttachment(filename: string, mimeType?: string): boolean {
  return getEligibleAttachmentKind(filename, mimeType) !== undefined;
}

export function isPdfAttachment(filename: string, mimeType?: string): boolean {
  const extension = path.extname(filename).toLowerCase();
  if (extension) return PDF_EXTENSIONS.has(extension);
  return PDF_MIME_TYPES.has(normalizedMimeType(mimeType));
}
