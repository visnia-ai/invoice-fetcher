export interface MailSearchOptions {
  accountEmail: string;
  startInclusive: Date;
  endExclusive: Date;
  stagingDirectory: string;
  keywords: readonly string[];
  onProgress?: (event: MailProgressEvent) => void;
  /**
   * Receives each unique attachment as soon as it has been staged. The source
   * awaits this callback so consumers can apply bounded backpressure.
   */
  onAttachment?: (attachment: MailAttachmentCandidate) => Promise<void>;
}

export type MailProvider = "imap" | "google";

export type MailProgressEvent =
  | { type: "connection-started"; provider: MailProvider; host: string }
  | { type: "authenticated"; provider: MailProvider; accountEmail: string }
  | { type: "account-selected"; accountName: string }
  | {
      type: "scan-started";
      scannedMessages: number;
      totalMessages: number;
      attachmentsStaged: number;
    }
  | {
      type: "mailbox-started" | "mailbox-completed";
      mailboxName: string;
      scannedMessages: number;
      totalMessages: number;
      attachmentsStaged: number;
    }
  | {
      type: "messages-scanned";
      scannedMessages: number;
      totalMessages: number;
      attachmentsStaged: number;
    }
  | {
      type: "attachment-staged";
      attachmentName: string;
      scannedMessages: number;
      totalMessages: number;
      attachmentsStaged: number;
    }
  | {
      type: "search-completed";
      scannedMessages: number;
      totalMessages: number;
      attachmentsStaged: number;
    };

export interface MailAttachmentCandidate {
  messageId: string;
  attachmentId: string;
  stagedPath: string;
  originalName: string;
  mimeType: string;
  size: number | null;
  sender: string;
  receivedAt: Date;
  emailContextMatches: boolean;
  emailReceiptMatches: boolean;
}

export type MailIssueCode =
  | "ATTACHMENT_METADATA_FAILED"
  | "ATTACHMENT_SAVE_FAILED"
  | "MESSAGE_READ_FAILED"
  | "MAILBOX_READ_FAILED";

export interface MailIssue {
  code: MailIssueCode;
  message: string;
  mailbox?: string;
  messageId?: string;
  attachmentName?: string;
}

export interface MailSearchResult {
  attachments: MailAttachmentCandidate[];
  issues: MailIssue[];
  scannedMessages: number;
}

export interface MailSource {
  search(options: MailSearchOptions): Promise<MailSearchResult>;
}

export type MailSourceErrorCode =
  | "ACCOUNT_NOT_FOUND"
  | "INVALID_REQUEST"
  | "MAIL_ACCESS_FAILED"
  | "MAIL_PROTOCOL_ERROR";

export class MailSourceError extends Error {
  readonly code: MailSourceErrorCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    code: MailSourceErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "MailSourceError";
    this.code = code;
    this.details = details;
  }
}
