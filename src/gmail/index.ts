export {
  createDefaultGmailApiClient,
  GoogleapisGmailClientAdapter,
} from "./default-client.js";
export type {
  DefaultGmailApiClientDependencies,
  GmailApiAdapterOptions,
  RawGmailApi,
} from "./default-client.js";
export { GmailApiMailSource, gmailSearchQuery } from "./gmail-mail-source.js";
export { buildGmailMessagePartPlan } from "./part-plan.js";
export {
  extractGmailMessageParts,
  type GmailPartExtractionRequest,
  type GmailPartExtractionResult,
} from "./part-extractor.js";
export type {
  GmailApiAttachment,
  GmailApiClient,
  GmailApiClientFactory,
  GmailApiConnectionProfile,
  GmailApiHeader,
  GmailApiListPage,
  GmailApiMessage,
  GmailApiMessagePart,
  GmailApiMessagePartBody,
  GmailApiProfileResolver,
  GmailAttachmentPart,
  GmailContextPart,
  GmailMailSourceDependencies,
  GmailMessagePartPlan,
  GmailSearchOptions,
  GmailSearchResult,
} from "./types.js";
