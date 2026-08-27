import type { Readable } from "node:stream";

import type {
  MailAttachmentCandidate,
  MailIssue,
  MailProgressEvent,
  MailProvider,
  MailSearchOptions,
  MailSearchResult,
} from "../mail/types.js";

export type ImapProvider = MailProvider;
export type ImapTlsMode = "implicit" | "starttls";

export type ImapAuthentication =
  | { type: "password"; password: string }
  | { type: "oauth2"; accessToken: string };

/** Fully resolved connection information. Secrets should be supplied just in time. */
export interface ImapConnectionProfile {
  provider: ImapProvider;
  email: string;
  host: string;
  port: number;
  tls: ImapTlsMode;
  username: string;
  authentication: ImapAuthentication;
}

export type ImapProfileResolver = (
  accountEmail: string,
) => Promise<ImapConnectionProfile>;

export type ImapProgressEvent = MailProgressEvent;
export type ImapSearchOptions = MailSearchOptions;

export interface ImapMailbox {
  path: string;
  delimiter: string;
  specialUse?: string;
  selectable: boolean;
}

export interface ImapMessageMetadata {
  uid: number;
  messageId?: string;
  receivedAt: Date;
  sender: string;
  subject: string;
  labels?: ReadonlySet<string>;
  hasAttachments: boolean;
  partPlan?: ImapMessagePartPlan;
}

export interface ImapAttachmentPart {
  part: string;
  attachmentId: string;
  originalName: string;
  mimeType: string;
  size: number | null;
}

export interface ImapContextPart {
  part: string;
  mimeType: "text/plain" | "text/html";
}

export interface ImapMessagePartPlan {
  attachments: readonly ImapAttachmentPart[];
  contextParts: readonly ImapContextPart[];
}

export interface ImapDownloadedPart {
  content: Readable;
  mimeType?: string;
  filename?: string;
}

export type ImapMetadataFetchResult =
  | {
      kind: "success";
      uid: number;
      metadata: ImapMessageMetadata;
    }
  | {
      kind: "error";
      uid: number;
      message: string;
    };

export interface ImapMailboxLock {
  release(): void;
}

export interface ImapReceivedSearchOptions {
  hasAttachmentsOnly: boolean;
}

export interface ImapClient {
  connect(): Promise<void>;
  listMailboxes(): Promise<readonly ImapMailbox[]>;
  lockMailbox(path: string): Promise<ImapMailboxLock>;
  searchReceived(
    startInclusive: Date,
    endExclusive: Date,
    options: ImapReceivedSearchOptions,
  ): Promise<readonly number[]>;
  fetchMetadataBatch(uids: readonly number[]): Promise<readonly ImapMetadataFetchResult[]>;
  downloadMessage(uid: number): Promise<Readable>;
  downloadPart(uid: number, part: string): Promise<ImapDownloadedPart>;
  logout(): Promise<void>;
}

export type ImapClientFactory = (
  profile: ImapConnectionProfile,
) => Promise<ImapClient> | ImapClient;

export interface ExtractedAttachment {
  attachmentId: string;
  stagedPath: string;
  originalName: string;
  mimeType: string;
  size: number | null;
}

export interface MimeExtractionRequest {
  source: Readable;
  stagingDirectory: string;
  subject: string;
  keywords: readonly string[];
}

export interface MimeExtractionResult {
  attachments: ExtractedAttachment[];
  emailContextMatches: boolean;
  emailReceiptMatches: boolean;
  issues: MailIssue[];
}

export interface MimeExtractor {
  extract(request: MimeExtractionRequest): Promise<MimeExtractionResult>;
}

export interface ImapMailSourceDependencies {
  clientFactory: ImapClientFactory;
  mimeExtractor: MimeExtractor;
  maximumConnections: number;
}

export interface ImapMailSearchResult extends MailSearchResult {
  attachments: MailAttachmentCandidate[];
}
