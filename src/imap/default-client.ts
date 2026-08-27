import { Readable } from "node:stream";

import type {
  ImapClient,
  ImapConnectionProfile,
  ImapMailbox,
  ImapMailboxLock,
  ImapDownloadedPart,
  ImapMetadataFetchResult,
  ImapMessageMetadata,
  ImapReceivedSearchOptions,
} from "./types.js";
import { isPdfAttachment } from "../detection/file-types.js";
import { buildImapMessagePartPlan } from "./part-plan.js";

interface RawMailbox {
  path: string;
  delimiter?: string;
  specialUse?: string;
  flags?: Set<string>;
}

interface RawAddress {
  name?: string;
  address?: string;
}

interface RawEnvelope {
  messageId?: string;
  subject?: string;
  from?: RawAddress[];
  date?: Date;
}

interface RawMessage {
  uid: number;
  envelope?: RawEnvelope;
  internalDate?: Date | string;
  labels?: Set<string>;
  bodyStructure?: unknown;
}

interface RawDownload {
  content: Readable;
  meta?: {
    contentType?: string;
    filename?: string;
  };
}

interface RawDownloadManyPart {
  content: Buffer | null;
  meta?: {
    contentType?: string;
    charset?: string;
    disposition?: string;
    filename?: string;
    flowed?: boolean;
    delSp?: boolean;
  };
}

interface RawImapFlowClient {
  connect(): Promise<void>;
  list(): Promise<RawMailbox[]>;
  getMailboxLock(path: string): Promise<ImapMailboxLock>;
  search(query: object, options: { uid: true }): Promise<number[] | false>;
  fetchAll(
    uids: number[],
    query: object,
    options: { uid: true },
  ): Promise<RawMessage[]>;
  download(
    uid: number,
    part: string | undefined,
    options: { uid: true },
  ): Promise<RawDownload>;
  downloadMany(
    uid: number,
    parts: string[],
    options: { uid: true },
  ): Promise<Record<string, RawDownloadManyPart>>;
  logout(): Promise<void>;
}

interface RawImapFlowConstructor {
  new (options: object): RawImapFlowClient;
}

async function loadImapFlow(): Promise<RawImapFlowConstructor> {
  // A non-literal import keeps local typechecking independent of dependency installation.
  const moduleName: string = "imapflow";
  const imported = (await import(moduleName)) as { ImapFlow: RawImapFlowConstructor };
  return imported.ImapFlow;
}

/** Production factory. Tests can inject the smaller ImapClient interface instead. */
export async function createDefaultImapClient(
  profile: ImapConnectionProfile,
): Promise<ImapClient> {
  const ImapFlow = await loadImapFlow();
  const auth =
    profile.authentication.type === "oauth2"
      ? { user: profile.username, accessToken: profile.authentication.accessToken }
      : { user: profile.username, pass: profile.authentication.password };
  const client = new ImapFlow({
    host: profile.host,
    port: profile.port,
    secure: profile.tls === "implicit",
    doSTARTTLS: profile.tls === "starttls",
    auth,
    logger: false,
  });
  return new ImapFlowClientAdapter(client);
}

export class ImapFlowClientAdapter implements ImapClient {
  constructor(private readonly client: RawImapFlowClient) {}

  async connect(): Promise<void> {
    await this.client.connect();
  }

  async listMailboxes(): Promise<readonly ImapMailbox[]> {
    const mailboxes = await this.client.list();
    return mailboxes.map((mailbox) => ({
      path: mailbox.path,
      delimiter: mailbox.delimiter || "/",
      ...(mailbox.specialUse ? { specialUse: mailbox.specialUse } : {}),
      selectable: !mailbox.flags?.has("\\Noselect"),
    }));
  }

  async lockMailbox(path: string): Promise<ImapMailboxLock> {
    return await this.client.getMailboxLock(path);
  }

  async searchReceived(
    startInclusive: Date,
    endExclusive: Date,
    options: ImapReceivedSearchOptions,
  ): Promise<readonly number[]> {
    // IMAP SEARCH carries calendar dates without a timezone. Query a one-day
    // safety margin on both sides, then ImapMailSource applies the exact local
    // instant bounds to INTERNALDATE so boundary messages cannot be missed.
    const matches = await this.client.search(
      imapServerSearchCriteria(startInclusive, endExclusive, options),
      { uid: true },
    );
    return matches || [];
  }

  async fetchMetadataBatch(
    uids: readonly number[],
  ): Promise<readonly ImapMetadataFetchResult[]> {
    if (uids.length === 0) return [];
    const messages = await this.client.fetchAll(
      [...uids],
      { envelope: true, internalDate: true, bodyStructure: true, labels: true },
      { uid: true },
    );
    const messagesByUid = new Map(messages.map((message) => [message.uid, message]));
    return uids.map((uid) => {
      const message = messagesByUid.get(uid);
      if (!message) {
        return {
          kind: "error" as const,
          uid,
          message: `Message UID ${uid} no longer exists.`,
        };
      }
      try {
        return { kind: "success" as const, uid, metadata: metadataFromRaw(message) };
      } catch (error) {
        return {
          kind: "error" as const,
          uid,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    });
  }

  async downloadMessage(uid: number): Promise<Readable> {
    return (await this.client.download(uid, undefined, { uid: true })).content;
  }

  async downloadPart(uid: number, part: string): Promise<ImapDownloadedPart> {
    if (!/^\d+(?:\.\d+)*$/u.test(part)) {
      throw new Error(`Invalid IMAP BODYSTRUCTURE part identifier: ${part}`);
    }
    // download() performs a sequence of bounded FETCH requests. For a selected
    // part we want one FETCH containing BODY[part.MIME] and BODY[part];
    // downloadMany() provides that behavior and still decodes transfer encoding.
    const downloaded = (await this.client.downloadMany(uid, [part], { uid: true }))[part];
    if (!downloaded || !Buffer.isBuffer(downloaded.content)) {
      throw new Error(`IMAP did not return BODYSTRUCTURE part ${part} for UID ${uid}.`);
    }
    const content = decodeTextPart(downloaded.content, downloaded.meta);
    return {
      content: Readable.from(content),
      ...(downloaded.meta?.contentType
        ? { mimeType: downloaded.meta.contentType }
        : {}),
      ...(downloaded.meta?.filename ? { filename: downloaded.meta.filename } : {}),
    };
  }

  async logout(): Promise<void> {
    await this.client.logout();
  }
}

function decodeTextPart(
  content: Buffer,
  meta: RawDownloadManyPart["meta"],
): Buffer {
  const contentType = meta?.contentType?.toLowerCase().trim();
  const isText =
    contentType === "text/plain" ||
    contentType === "text/html" ||
    contentType === "text/x-amp-html";
  if (
    !isText ||
    meta?.filename ||
    (meta?.disposition && meta.disposition !== "inline")
  ) {
    return content;
  }

  let decoded = meta?.flowed ? decodeFlowed(content, meta.delSp === true) : content;
  const charset = meta?.charset?.trim();
  if (!charset || /^(?:ascii|us-?ascii|utf-?8)$/iu.test(charset)) return decoded;
  try {
    decoded = Buffer.from(new TextDecoder(charset).decode(decoded), "utf8");
  } catch {
    // Match ImapFlow.download(): unknown charsets are returned unchanged.
  }
  return decoded;
}

function decodeFlowed(content: Buffer, delSp: boolean): Buffer {
  const lines = content.toString("latin1").split(/\r?\n/u);
  const result: string[] = [];
  let buffer: string | undefined;
  for (const line of lines) {
    if (
      buffer !== undefined &&
      buffer.endsWith(" ") &&
      !/(^|\n)-- $/u.test(buffer)
    ) {
      buffer = delSp ? `${buffer.slice(0, -1)}${line}` : `${buffer}${line}`;
    } else {
      if (buffer !== undefined) result.push(buffer);
      buffer = line;
    }
  }
  if (buffer) result.push(buffer);
  return Buffer.from(result.join("\n").replace(/^ /gmu, ""), "latin1");
}

function metadataFromRaw(message: RawMessage): ImapMessageMetadata {
  const rawReceivedAt = message.internalDate ?? message.envelope?.date;
  const receivedAt =
    rawReceivedAt instanceof Date ? rawReceivedAt : new Date(rawReceivedAt ?? Number.NaN);
  if (Number.isNaN(receivedAt.getTime())) {
    throw new Error(`Message UID ${message.uid} has no valid received date.`);
  }
  const partPlan = buildImapMessagePartPlan(message.bodyStructure);
  return {
    uid: message.uid,
    ...(message.envelope?.messageId
      ? { messageId: message.envelope.messageId }
      : {}),
    receivedAt,
    sender: formatSender(message.envelope?.from?.[0]),
    subject: message.envelope?.subject ?? "",
    ...(message.labels ? { labels: message.labels } : {}),
    hasAttachments:
      partPlan !== undefined
        ? partPlan.attachments.length > 0
        : bodyStructureHasAttachment(message.bodyStructure),
    ...(partPlan ? { partPlan } : {}),
  };
}

export function imapServerSearchWindow(
  startInclusive: Date,
  endExclusive: Date,
): { since: Date; before: Date } {
  const since = new Date(startInclusive);
  since.setDate(since.getDate() - 1);
  const before = new Date(endExclusive);
  before.setDate(before.getDate() + 1);
  return { since, before };
}

export function imapServerSearchCriteria(
  startInclusive: Date,
  endExclusive: Date,
  options: ImapReceivedSearchOptions,
): { since: Date; before: Date; gmailraw?: string } {
  const window = imapServerSearchWindow(startInclusive, endExclusive);
  return options.hasAttachmentsOnly
    ? { ...window, gmailraw: "has:attachment" }
    : window;
}

function formatSender(sender: RawAddress | undefined): string {
  if (!sender?.address) return "";
  return sender.name ? `${sender.name} <${sender.address}>` : sender.address;
}

function bodyStructureHasAttachment(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const node = value as Record<string, unknown>;
  const parameters = isRecord(node.parameters) ? node.parameters : undefined;
  const dispositionParameters = isRecord(node.dispositionParameters)
    ? node.dispositionParameters
    : undefined;
  const filename =
    stringParameter(dispositionParameters, "filename", "filename*") ??
    stringParameter(parameters, "name", "name*") ??
    "";
  if (isPdfAttachment(filename, typeof node.type === "string" ? node.type : undefined)) {
    return true;
  }
  const children = node.childNodes;
  return Array.isArray(children) && children.some(bodyStructureHasAttachment);
}

function stringParameter(
  value: Record<string, unknown> | undefined,
  ...names: readonly string[]
): string | undefined {
  if (!value) return undefined;
  const wanted = new Set(names);
  for (const [key, candidate] of Object.entries(value)) {
    if (wanted.has(key.toLowerCase()) && typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
