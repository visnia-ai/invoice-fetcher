import type {
  MailProvider,
  MailSearchOptions,
  MailSearchResult,
  MailSource,
} from "./types.js";

export type MailProviderResolver = (accountEmail: string) => Promise<MailProvider>;

/** Routes configured Google accounts to Gmail while retaining IMAP elsewhere. */
export class ProviderRoutingMailSource implements MailSource {
  constructor(
    private readonly resolveProvider: MailProviderResolver,
    private readonly sources: {
      google: MailSource;
      imap: MailSource;
    },
  ) {}

  async search(options: MailSearchOptions): Promise<MailSearchResult> {
    const provider = await this.resolveProvider(options.accountEmail);
    return await (provider === "google" ? this.sources.google : this.sources.imap).search(
      options,
    );
  }
}
