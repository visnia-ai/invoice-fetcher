export const ACCOUNT_PROVIDERS = ["imap", "google"] as const;

export type AccountProvider = (typeof ACCOUNT_PROVIDERS)[number];
export type TlsMode = "implicit" | "starttls";

interface BaseAccountProfile {
  readonly version: 1;
  readonly email: string;
  readonly provider: AccountProvider;
  readonly host: string;
  readonly port: number;
  readonly tls: TlsMode;
  readonly username: string;
}

export interface ImapAccountProfile extends BaseAccountProfile {
  readonly provider: "imap";
}

export interface GoogleAccountProfile extends BaseAccountProfile {
  readonly provider: "google";
  readonly host: "imap.gmail.com";
  readonly port: 993;
  readonly tls: "implicit";
}

export type AccountProfile =
  | ImapAccountProfile
  | GoogleAccountProfile;

export function normalizeAccountEmail(email: string): string {
  return email.trim().toLocaleLowerCase("en-US");
}

export function isAccountProvider(value: string): value is AccountProvider {
  return (ACCOUNT_PROVIDERS as readonly string[]).includes(value);
}
