import type { MailSearchOptions, MailSearchResult } from "../mail/types.js";
import type { MimeExtractor } from "../imap/types.js";

export interface GmailApiConnectionProfile {
  email: string;
  accessToken: string;
  expiresAt: Date;
  tokenType: string;
  scope: string;
  oauthClient: {
    clientId: string;
    clientSecret?: string;
  };
}

export type GmailApiProfileResolver = (
  accountEmail: string,
) => Promise<GmailApiConnectionProfile>;

export interface GmailApiHeader {
  name: string;
  value: string;
}

export interface GmailApiMessagePartBody {
  attachmentId?: string;
  size?: number;
  data?: string;
}

export interface GmailApiMessagePart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers: readonly GmailApiHeader[];
  body?: GmailApiMessagePartBody;
  parts: readonly GmailApiMessagePart[];
}

export interface GmailApiMessage {
  id: string;
  labelIds: readonly string[];
  internalDate?: string;
  payload?: GmailApiMessagePart;
}

export interface GmailApiListPage {
  messageIds: readonly string[];
  nextPageToken?: string;
}

export interface GmailApiAttachment {
  data: string;
  size?: number;
}

export interface GmailApiClient {
  getProfile(): Promise<{ emailAddress: string }>;
  listMessages(input: {
    query: string;
    maxResults: number;
    pageToken?: string;
  }): Promise<GmailApiListPage>;
  getMessage(messageId: string): Promise<GmailApiMessage>;
  getRawMessage(messageId: string): Promise<string>;
  getAttachment(messageId: string, attachmentId: string): Promise<GmailApiAttachment>;
}

export type GmailApiClientFactory = (
  profile: GmailApiConnectionProfile,
) => Promise<GmailApiClient> | GmailApiClient;

export interface GmailAttachmentPart {
  partId: string;
  attachmentId: string;
  originalName: string;
  mimeType: string;
  size: number | null;
  inlineData?: string;
  externalAttachmentId?: string;
}

export interface GmailContextPart {
  partId: string;
  mimeType: "text/plain" | "text/html";
  charset?: string;
  flowed?: boolean;
  delSp?: boolean;
  inlineData?: string;
  externalAttachmentId?: string;
}

export interface GmailMessagePartPlan {
  attachments: readonly GmailAttachmentPart[];
  contextParts: readonly GmailContextPart[];
}

export interface GmailMailSourceDependencies {
  clientFactory: GmailApiClientFactory;
  mimeExtractor: MimeExtractor;
  requestConcurrency: number;
  workingChunkSize: number;
}

export type GmailSearchOptions = MailSearchOptions;
export type GmailSearchResult = MailSearchResult;
