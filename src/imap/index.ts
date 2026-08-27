export {
  createDefaultImapClient,
  ImapFlowClientAdapter,
  imapServerSearchCriteria,
  imapServerSearchWindow,
} from "./default-client.js";
export { ImapMailSource, selectReceivedMailboxes } from "./imap-mail-source.js";
export { StreamingMailParserExtractor } from "./mailparser-extractor.js";
export { buildImapMessagePartPlan } from "./part-plan.js";
export {
  extractPlannedMessageParts,
  matchesMessageKeyword,
} from "./part-extractor.js";
export type {
  PlannedPartExtractionRequest,
  PlannedPartExtractionResult,
} from "./part-extractor.js";
export type {
  ImapAttachmentPart,
  ExtractedAttachment,
  ImapAuthentication,
  ImapClient,
  ImapClientFactory,
  ImapConnectionProfile,
  ImapMailSearchResult,
  ImapMailbox,
  ImapMailboxLock,
  ImapMetadataFetchResult,
  ImapMessageMetadata,
  ImapMessagePartPlan,
  ImapContextPart,
  ImapDownloadedPart,
  ImapProfileResolver,
  ImapProgressEvent,
  ImapProvider,
  ImapReceivedSearchOptions,
  ImapSearchOptions,
  ImapTlsMode,
  MimeExtractionRequest,
  MimeExtractionResult,
  MimeExtractor,
} from "./types.js";
