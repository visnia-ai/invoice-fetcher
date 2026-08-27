import { constants as fsConstants, createReadStream } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { domainToASCII } from "node:url";

export interface OrganizeInvoiceInput {
  stagedPath: string;
  originalName: string;
  sender: string;
  receivedAt: Date;
  destinationRoot: string;
  spansMultipleMonths: boolean;
}

export type OrganizeInvoiceResult =
  | { status: "copied"; destinationPath: string }
  | { status: "duplicate"; destinationPath: string };

const VALID_DOMAIN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function extractSenderDomain(sender: string): string {
  const addresses = sender.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[^\s<>,;]+/giu);
  const address = addresses?.at(-1);
  if (!address) return "_unknown-sender";

  const rawDomain = address.slice(address.lastIndexOf("@") + 1).replace(/[.>]+$/u, "");
  const asciiDomain = domainToASCII(rawDomain).toLowerCase();
  return VALID_DOMAIN.test(asciiDomain) ? asciiDomain : "_unknown-sender";
}

export function sanitizeAttachmentName(originalName: string): string {
  const normalized = originalName.normalize("NFKC").replaceAll("\\", "/");
  let name = path.posix.basename(normalized)
    .replace(/[\u0000-\u001f\u007f]/gu, "_")
    .replace(/[:/]/gu, "_")
    .replace(/^\.+/u, "")
    .trim();

  if (!name) name = "attachment";
  return truncateUtf8Filename(name, 220);
}

export function invoiceDirectory(
  destinationRoot: string,
  sender: string,
  receivedAt: Date,
  spansMultipleMonths: boolean,
): string {
  const domain = extractSenderDomain(sender);
  if (!spansMultipleMonths) return path.join(destinationRoot, domain);

  const month = `${receivedAt.getFullYear()}-${String(receivedAt.getMonth() + 1).padStart(2, "0")}`;
  return path.join(destinationRoot, month, domain);
}

export async function organizeInvoice(
  input: OrganizeInvoiceInput,
): Promise<OrganizeInvoiceResult> {
  const directory = invoiceDirectory(
    input.destinationRoot,
    input.sender,
    input.receivedAt,
    input.spansMultipleMonths,
  );
  await mkdir(directory, { recursive: true });

  const safeName = sanitizeAttachmentName(input.originalName);
  const extension = path.extname(safeName);
  const stem = path.basename(safeName, extension);
  let sourceHash: string | undefined;

  for (let copyNumber = 1; ; copyNumber += 1) {
    const filename = copyNumber === 1 ? safeName : `${stem} (${copyNumber})${extension}`;
    const destinationPath = path.join(directory, filename);

    try {
      await copyFile(input.stagedPath, destinationPath, fsConstants.COPYFILE_EXCL);
      return { status: "copied", destinationPath };
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;

      sourceHash ??= await hashFile(input.stagedPath);
      if (sourceHash === (await hashFile(destinationPath))) {
        return { status: "duplicate", destinationPath };
      }
    }
  }
}

async function hashFile(filename: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}

function truncateUtf8Filename(filename: string, maximumBytes: number): string {
  if (Buffer.byteLength(filename) <= maximumBytes) return filename;

  const extension = path.extname(filename);
  const extensionBytes = Buffer.byteLength(extension);
  const byteBudget = Math.max(1, maximumBytes - extensionBytes);
  let stem = "";
  for (const character of path.basename(filename, extension)) {
    if (Buffer.byteLength(stem + character) > byteBudget) break;
    stem += character;
  }
  return `${stem || "attachment"}${extension}`;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
