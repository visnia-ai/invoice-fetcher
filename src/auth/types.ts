export const GOOGLE_MAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
export const GOOGLE_OAUTH_SCOPES = [GOOGLE_MAIL_SCOPE] as const;

export interface GoogleOAuthClient {
  clientId: string;
  clientSecret?: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
}

/** A single opaque value that can be stored in macOS Keychain. */
export interface GoogleOAuthStoredCredential {
  kind: "google-oauth";
  version: 1;
  client: GoogleOAuthClient;
  refreshToken: string;
  scope: string;
}

export interface GoogleAccessToken {
  /** Keep this token in memory only. */
  accessToken: string;
  expiresAt: Date;
  tokenType: string;
  scope: string;
}

export interface GoogleAuthorizationResult {
  credential: GoogleOAuthStoredCredential;
  token: GoogleAccessToken;
  accountEmail: string;
  refreshTokenExpiresAt?: Date;
}

export interface GoogleRefreshResult {
  credential: GoogleOAuthStoredCredential;
  token: GoogleAccessToken;
}

export type GoogleOAuthErrorCode =
  | "INVALID_CLIENT_CONFIG"
  | "INVALID_STORED_CREDENTIAL"
  | "BROWSER_OPEN_FAILED"
  | "CALLBACK_TIMEOUT"
  | "CALLBACK_FAILED"
  | "STATE_MISMATCH"
  | "AUTHORIZATION_DENIED"
  | "TOKEN_EXCHANGE_FAILED"
  | "TOKEN_REFRESH_FAILED"
  | "TOKEN_REVOKED"
  | "TOKEN_REVOCATION_FAILED"
  | "UNEXPECTED_SCOPE"
  | "ACCOUNT_LOOKUP_FAILED";

export class GoogleOAuthError extends Error {
  readonly code: GoogleOAuthErrorCode;

  constructor(code: GoogleOAuthErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GoogleOAuthError";
    this.code = code;
  }
}

export interface OAuthCallbackResult {
  code: string;
}

export interface OAuthCallbackListener {
  readonly redirectUri: string;
  waitForCallback(expectedState: string, signal: AbortSignal): Promise<OAuthCallbackResult>;
  close(): Promise<void>;
}

export type OAuthCallbackListenerFactory = () => Promise<OAuthCallbackListener>;
export type BrowserOpener = (authorizationUrl: string) => Promise<void>;

export interface OAuthTokenTransport {
  postForm(
    endpoint: string,
    parameters: URLSearchParams,
    signal: AbortSignal,
  ): Promise<unknown>;
}

export interface GoogleGmailProfileTransport {
  getEmail(accessToken: string, signal: AbortSignal): Promise<string>;
}

export interface OAuthRevocationTransport {
  revoke(
    refreshToken: string,
    signal: AbortSignal,
  ): Promise<"revoked" | "already-invalid">;
}

export interface GoogleOAuthFlowDependencies {
  browserOpener?: BrowserOpener;
  callbackListenerFactory?: OAuthCallbackListenerFactory;
  tokenTransport?: OAuthTokenTransport;
  gmailProfileTransport?: GoogleGmailProfileTransport;
  revocationTransport?: OAuthRevocationTransport;
  randomBytes?: (size: number) => Uint8Array;
  now?: () => number;
  timeoutMs?: number;
}

export interface ImapConnectionSettings {
  readonly host: string;
  readonly port: number;
  readonly tlsMode: "implicit-tls" | "starttls";
}

export interface ImapPasswordAuth {
  readonly method: "password";
  readonly username: string;
  readonly password: string;
}

export interface ImapOAuth2Auth {
  readonly method: "oauth2";
  readonly username: string;
  readonly accessToken: string;
}
