import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import { requireSupportedPlatform } from "../platform.js";

import {
  GOOGLE_OAUTH_SCOPES,
  GoogleOAuthError,
  type BrowserOpener,
  type GoogleAccessToken,
  type GoogleAuthorizationResult,
  type GoogleGmailProfileTransport,
  type GoogleOAuthClient,
  type GoogleOAuthFlowDependencies,
  type GoogleOAuthStoredCredential,
  type GoogleRefreshResult,
  type OAuthCallbackListener,
  type OAuthRevocationTransport,
  type OAuthTokenTransport,
} from "./types.js";

const DEFAULT_AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const DEFAULT_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const TOKEN_REVOCATION_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const DEFAULT_TIMEOUT_MS = 120_000;
const CALLBACK_PATH = "/oauth2/callback";

interface GoogleTokenResponse {
  access_token: string;
  expires_in: number;
  token_type?: string;
  refresh_token?: string;
  scope?: string;
  refresh_token_expires_in?: number;
}

export class GoogleOAuthFlow {
  private readonly browserOpener: BrowserOpener;
  private readonly callbackListenerFactory: () => Promise<OAuthCallbackListener>;
  private readonly tokenTransport: OAuthTokenTransport;
  private readonly gmailProfileTransport: GoogleGmailProfileTransport;
  private readonly revocationTransport: OAuthRevocationTransport;
  private readonly randomBytes: (size: number) => Uint8Array;
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(dependencies: GoogleOAuthFlowDependencies = {}) {
    this.browserOpener = dependencies.browserOpener ?? openInDefaultBrowser;
    this.callbackListenerFactory =
      dependencies.callbackListenerFactory ?? createLoopbackOAuthCallbackListener;
    this.tokenTransport = dependencies.tokenTransport ?? new FetchOAuthTokenTransport();
    this.gmailProfileTransport =
      dependencies.gmailProfileTransport ?? new FetchGmailProfileTransport();
    this.revocationTransport =
      dependencies.revocationTransport ?? new FetchOAuthRevocationTransport();
    this.randomBytes = dependencies.randomBytes ?? nodeRandomBytes;
    this.now = dependencies.now ?? Date.now;
    this.timeoutMs = dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new TypeError("OAuth timeout must be a positive integer.");
    }
  }

  async authorize(
    client: GoogleOAuthClient,
    loginHint?: string,
  ): Promise<GoogleAuthorizationResult> {
    validateClient(client);
    const listener = await this.callbackListenerFactory();
    const state = base64Url(this.randomBytes(32));
    const codeVerifier = base64Url(this.randomBytes(64));
    const codeChallenge = base64Url(createHash("sha256").update(codeVerifier).digest());
    const authorizationUrl = createAuthorizationUrl(
      client,
      listener.redirectUri,
      state,
      codeChallenge,
      loginHint,
    );
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      try {
        await this.browserOpener(authorizationUrl);
      } catch (error) {
        throw new GoogleOAuthError(
          "BROWSER_OPEN_FAILED",
          "Could not open the browser for Google authorization.",
          { cause: error },
        );
      }

      let code: string;
      try {
        ({ code } = await listener.waitForCallback(state, controller.signal));
      } catch (error) {
        if (error instanceof GoogleOAuthError) throw error;
        if (controller.signal.aborted) {
          throw new GoogleOAuthError(
            "CALLBACK_TIMEOUT",
            "Timed out waiting for Google authorization.",
            { cause: error },
          );
        }
        throw new GoogleOAuthError(
          "CALLBACK_FAILED",
          "Google authorization callback failed.",
          { cause: error },
        );
      }

      const parameters = new URLSearchParams({
        client_id: client.clientId,
        code,
        code_verifier: codeVerifier,
        grant_type: "authorization_code",
        redirect_uri: listener.redirectUri,
      });
      if (client.clientSecret !== undefined) parameters.set("client_secret", client.clientSecret);
      const raw = await this.postTokenForm(
        client.tokenEndpoint,
        parameters,
        controller.signal,
        "TOKEN_EXCHANGE_FAILED",
      );
      const response = parseTokenResponse(raw, "TOKEN_EXCHANGE_FAILED");
      if (response.refresh_token === undefined || response.refresh_token.length === 0) {
        throw new GoogleOAuthError(
          "TOKEN_EXCHANGE_FAILED",
          "Google did not return an offline refresh token. Re-authorize the account.",
        );
      }
      const credential: GoogleOAuthStoredCredential = {
        kind: "google-oauth",
        version: 1,
        client: copyClient(client),
        refreshToken: response.refresh_token,
        scope: response.scope ?? GOOGLE_OAUTH_SCOPES.join(" "),
      };
      if (!hasExactGoogleMailScope(credential.scope)) {
        await this.revoke(credential);
        throw new GoogleOAuthError(
          "UNEXPECTED_SCOPE",
          "Google granted permissions other than read-only Gmail access. The grant was revoked; retry authorization.",
        );
      }
      let accountEmail: string;
      try {
        accountEmail = await this.gmailProfileTransport.getEmail(
          response.access_token,
          controller.signal,
        );
      } catch (error) {
        if (error instanceof GoogleOAuthError) throw error;
        throw new GoogleOAuthError(
          "ACCOUNT_LOOKUP_FAILED",
          "Could not determine which Google account was authorized.",
          { cause: error },
        );
      }
      const refreshTokenExpiresAt =
        response.refresh_token_expires_in === undefined
          ? undefined
          : new Date(this.now() + response.refresh_token_expires_in * 1_000);
      return {
        credential,
        token: this.toAccessToken(response, credential.scope),
        accountEmail,
        ...(refreshTokenExpiresAt === undefined ? {} : { refreshTokenExpiresAt }),
      };
    } finally {
      clearTimeout(timeout);
      controller.abort();
      await listener.close().catch(() => undefined);
    }
  }

  async refresh(credential: GoogleOAuthStoredCredential): Promise<GoogleRefreshResult> {
    validateStoredCredential(credential);
    if (!hasExactGoogleMailScope(credential.scope)) {
      throw new GoogleOAuthError(
        "UNEXPECTED_SCOPE",
        "Stored Google permissions are not read-only. Re-authorize this account with --replace before continuing.",
      );
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const parameters = new URLSearchParams({
      client_id: credential.client.clientId,
      grant_type: "refresh_token",
      refresh_token: credential.refreshToken,
    });
    if (credential.client.clientSecret !== undefined) {
      parameters.set("client_secret", credential.client.clientSecret);
    }

    try {
      const raw = await this.postTokenForm(
        credential.client.tokenEndpoint,
        parameters,
        controller.signal,
        "TOKEN_REFRESH_FAILED",
      );
      const response = parseTokenResponse(raw, "TOKEN_REFRESH_FAILED");
      const updatedCredential: GoogleOAuthStoredCredential = {
        ...credential,
        refreshToken: response.refresh_token ?? credential.refreshToken,
        scope: response.scope ?? credential.scope,
      };
      if (!hasExactGoogleMailScope(updatedCredential.scope)) {
        await this.revoke(updatedCredential);
        throw new GoogleOAuthError(
          "UNEXPECTED_SCOPE",
          "Google returned permissions other than read-only Gmail access. The grant was revoked; retry authorization.",
        );
      }
      return {
        credential: updatedCredential,
        token: this.toAccessToken(response, updatedCredential.scope),
      };
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  }

  async revoke(credential: GoogleOAuthStoredCredential): Promise<void> {
    validateStoredCredential(credential);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      await this.revocationTransport.revoke(credential.refreshToken, controller.signal);
    } catch (error) {
      if (error instanceof GoogleOAuthError) throw error;
      throw new GoogleOAuthError(
        "TOKEN_REVOCATION_FAILED",
        "Could not revoke the previous Google authorization. Retry before authorizing again.",
        { cause: error },
      );
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  }

  private async postTokenForm(
    endpoint: string,
    parameters: URLSearchParams,
    signal: AbortSignal,
    fallbackCode: "TOKEN_EXCHANGE_FAILED" | "TOKEN_REFRESH_FAILED",
  ): Promise<unknown> {
    try {
      const response = await this.tokenTransport.postForm(endpoint, parameters, signal);
      if (isObject(response) && typeof response.error === "string") {
        const revoked = fallbackCode === "TOKEN_REFRESH_FAILED" && response.error === "invalid_grant";
        throw new GoogleOAuthError(
          revoked ? "TOKEN_REVOKED" : fallbackCode,
          revoked
            ? "Google authorization is expired or revoked. Add the account again."
            : "Google OAuth token request failed.",
        );
      }
      return response;
    } catch (error) {
      if (error instanceof GoogleOAuthError) throw error;
      throw new GoogleOAuthError(fallbackCode, "Google OAuth token request failed.", {
        cause: error,
      });
    }
  }

  private toAccessToken(response: GoogleTokenResponse, fallbackScope: string): GoogleAccessToken {
    return {
      accessToken: response.access_token,
      expiresAt: new Date(this.now() + response.expires_in * 1_000),
      tokenType: response.token_type ?? "Bearer",
      scope: response.scope ?? fallbackScope,
    };
  }
}

export function parseGoogleOAuthClientJson(input: string | Uint8Array): GoogleOAuthClient {
  let parsed: unknown;
  try {
    const text = typeof input === "string" ? input : Buffer.from(input).toString("utf8");
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new GoogleOAuthError(
      "INVALID_CLIENT_CONFIG",
      "Google OAuth client file is not valid JSON.",
      { cause: error },
    );
  }
  if (!isObject(parsed) || !isObject(parsed.installed)) {
    throw new GoogleOAuthError(
      "INVALID_CLIENT_CONFIG",
      "Google OAuth client file must contain an installed desktop client.",
    );
  }
  const installed = parsed.installed;
  const clientId = requiredString(installed.client_id);
  const authorizationEndpoint = optionalString(installed.auth_uri) ?? DEFAULT_AUTHORIZATION_ENDPOINT;
  const tokenEndpoint = optionalString(installed.token_uri) ?? DEFAULT_TOKEN_ENDPOINT;
  const clientSecret = optionalString(installed.client_secret);
  if (clientId === undefined || !isHttpsUrl(authorizationEndpoint) || !isHttpsUrl(tokenEndpoint)) {
    throw new GoogleOAuthError(
      "INVALID_CLIENT_CONFIG",
      "Google OAuth desktop client configuration is missing valid endpoints or a client ID.",
    );
  }
  return clientSecret === undefined
    ? { clientId, authorizationEndpoint, tokenEndpoint }
    : { clientId, clientSecret, authorizationEndpoint, tokenEndpoint };
}

export function serializeGoogleOAuthCredential(credential: GoogleOAuthStoredCredential): string {
  validateStoredCredential(credential);
  return JSON.stringify(credential);
}

export function hasExactGoogleMailScope(scope: string): boolean {
  const scopes = new Set(scope.trim().split(/\s+/u).filter(Boolean));
  return scopes.size === 1 && scopes.has(GOOGLE_OAUTH_SCOPES[0]);
}

export function parseGoogleOAuthCredential(value: string): GoogleOAuthStoredCredential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new GoogleOAuthError(
      "INVALID_STORED_CREDENTIAL",
      "Stored Google OAuth credential is invalid.",
      { cause: error },
    );
  }
  validateStoredCredential(parsed);
  return parsed;
}

export function createAuthorizationUrl(
  client: GoogleOAuthClient,
  redirectUri: string,
  state: string,
  codeChallenge: string,
  loginHint?: string,
): string {
  validateClient(client);
  const url = new URL(client.authorizationEndpoint);
  const parameters = new URLSearchParams({
    access_type: "offline",
    client_id: client.clientId,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    prompt: "consent",
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GOOGLE_OAUTH_SCOPES.join(" "),
    state,
  });
  if (loginHint !== undefined && loginHint.trim().length > 0) {
    parameters.set("login_hint", loginHint.trim());
  }
  url.search = parameters.toString();
  return url.toString();
}

export async function createLoopbackOAuthCallbackListener(): Promise<OAuthCallbackListener> {
  return LoopbackOAuthCallbackListener.create();
}

export class LoopbackOAuthCallbackListener implements OAuthCallbackListener {
  readonly redirectUri: string;

  private constructor(private readonly server: Server, port: number) {
    this.redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
  }

  static async create(): Promise<LoopbackOAuthCallbackListener> {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      server.once("error", onError);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", onError);
        resolve();
      });
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      throw new GoogleOAuthError("CALLBACK_FAILED", "Could not start the OAuth callback server.");
    }
    return new LoopbackOAuthCallbackListener(server, address.port);
  }

  waitForCallback(expectedState: string, signal: AbortSignal): Promise<{ code: string }> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (error: unknown, code?: string): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        this.server.removeListener("request", onRequest);
        if (error !== undefined) reject(error);
        else if (code !== undefined) resolve({ code });
      };
      const onAbort = (): void => {
        settle(new GoogleOAuthError("CALLBACK_TIMEOUT", "Timed out waiting for Google authorization."));
      };
      const onRequest = (request: IncomingMessage, response: ServerResponse): void => {
        const requestUrl = new URL(request.url ?? "/", this.redirectUri);
        if (requestUrl.pathname !== CALLBACK_PATH) {
          response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
          response.end("Not found");
          return;
        }
        let code: string;
        try {
          ({ code } = parseGoogleOAuthCallbackUrl(requestUrl, expectedState));
        } catch (error) {
          response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
          response.end("Authorization was not completed. You can close this window.");
          settle(error);
          return;
        }
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        });
        response.end("<!doctype html><title>Invoice Fetcher</title><p>Authorization complete. You can close this window.</p>");
        settle(undefined, code);
      };
      this.server.on("request", onRequest);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }

  async close(): Promise<void> {
    if (!this.server.listening) return;
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

export class FetchOAuthTokenTransport implements OAuthTokenTransport {
  async postForm(
    endpoint: string,
    parameters: URLSearchParams,
    signal: AbortSignal,
  ): Promise<unknown> {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: parameters,
      signal,
    });
    let payload: unknown;
    try {
      payload = (await response.json()) as unknown;
    } catch (error) {
      throw new Error("Google returned an invalid token response.", { cause: error });
    }
    if (!response.ok && !(isObject(payload) && typeof payload.error === "string")) {
      throw new Error("Google rejected the token request.");
    }
    return payload;
  }
}

export class FetchGmailProfileTransport implements GoogleGmailProfileTransport {
  constructor(private readonly fetch: typeof globalThis.fetch = globalThis.fetch) {}

  async getEmail(accessToken: string, signal: AbortSignal): Promise<string> {
    const response = await this.fetch(
      "https://gmail.googleapis.com/gmail/v1/users/me/profile?fields=emailAddress",
      {
        headers: { authorization: `Bearer ${accessToken}` },
        signal,
      },
    );
    let payload: unknown;
    try {
      payload = (await response.json()) as unknown;
    } catch (error) {
      throw new Error("Google returned an invalid account response.", { cause: error });
    }
    if (
      !response.ok ||
      !isObject(payload) ||
      typeof payload.emailAddress !== "string" ||
      payload.emailAddress.trim().length === 0
    ) {
      throw new Error("Google did not return the authorized account email.");
    }
    return payload.emailAddress.trim().toLocaleLowerCase("en-US");
  }
}

export class FetchOAuthRevocationTransport implements OAuthRevocationTransport {
  constructor(private readonly fetch: typeof globalThis.fetch = globalThis.fetch) {}

  async revoke(
    refreshToken: string,
    signal: AbortSignal,
  ): Promise<"revoked" | "already-invalid"> {
    const response = await this.fetch(TOKEN_REVOCATION_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: refreshToken }),
      signal,
    });
    if (response.ok) return "revoked";
    if (response.status === 400) return "already-invalid";
    throw new Error(`Google token revocation failed with HTTP ${response.status}.`);
  }
}

export function parseGoogleOAuthCallbackUrl(
  callbackUrl: URL | string,
  expectedState: string,
): { code: string } {
  const url = typeof callbackUrl === "string" ? new URL(callbackUrl) : callbackUrl;
  if (url.searchParams.get("state") !== expectedState) {
    throw new GoogleOAuthError("STATE_MISMATCH", "Google authorization state did not match.");
  }
  if (url.searchParams.has("error")) {
    throw new GoogleOAuthError("AUTHORIZATION_DENIED", "Google authorization was denied.");
  }
  const code = url.searchParams.get("code");
  if (code === null || code.length === 0) {
    throw new GoogleOAuthError("CALLBACK_FAILED", "Google authorization code was missing.");
  }
  return { code };
}

export interface BrowserOpenCommand {
  readonly executable: string;
  readonly args: readonly string[];
}

export function defaultBrowserOpenCommand(
  authorizationUrl: string,
  platform: NodeJS.Platform = process.platform,
): BrowserOpenCommand {
  switch (requireSupportedPlatform(platform)) {
    case "darwin":
      return { executable: "/usr/bin/open", args: [authorizationUrl] };
    case "linux":
      return { executable: "xdg-open", args: [authorizationUrl] };
    case "win32":
      return {
        executable: "rundll32.exe",
        args: ["url.dll,FileProtocolHandler", authorizationUrl],
      };
  }
}

export const openInDefaultBrowser: BrowserOpener = async (authorizationUrl) => {
  const command = defaultBrowserOpenCommand(authorizationUrl);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.executable, command.args, {
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error("Browser opener exited unsuccessfully."));
    });
  });
};

function parseTokenResponse(
  value: unknown,
  code: "TOKEN_EXCHANGE_FAILED" | "TOKEN_REFRESH_FAILED",
): GoogleTokenResponse {
  if (
    !isObject(value) ||
    typeof value.access_token !== "string" ||
    value.access_token.length === 0 ||
    typeof value.expires_in !== "number" ||
    !Number.isFinite(value.expires_in) ||
    value.expires_in <= 0
  ) {
    throw new GoogleOAuthError(code, "Google returned an invalid token response.");
  }
  const response: GoogleTokenResponse = {
    access_token: value.access_token,
    expires_in: value.expires_in,
  };
  if (typeof value.token_type === "string" && value.token_type.length > 0) {
    response.token_type = value.token_type;
  }
  if (typeof value.refresh_token === "string" && value.refresh_token.length > 0) {
    response.refresh_token = value.refresh_token;
  }
  if (typeof value.scope === "string" && value.scope.length > 0) response.scope = value.scope;
  if (
    typeof value.refresh_token_expires_in === "number" &&
    Number.isFinite(value.refresh_token_expires_in) &&
    value.refresh_token_expires_in > 0
  ) {
    response.refresh_token_expires_in = value.refresh_token_expires_in;
  }
  return response;
}

function validateClient(value: GoogleOAuthClient): void {
  if (
    value.clientId.trim().length === 0 ||
    !isHttpsUrl(value.authorizationEndpoint) ||
    !isHttpsUrl(value.tokenEndpoint)
  ) {
    throw new GoogleOAuthError("INVALID_CLIENT_CONFIG", "Google OAuth client configuration is invalid.");
  }
}

function validateStoredCredential(value: unknown): asserts value is GoogleOAuthStoredCredential {
  if (
    !isObject(value) ||
    value.kind !== "google-oauth" ||
    value.version !== 1 ||
    !isObject(value.client) ||
    typeof value.client.clientId !== "string" ||
    typeof value.client.authorizationEndpoint !== "string" ||
    typeof value.client.tokenEndpoint !== "string" ||
    (value.client.clientSecret !== undefined && typeof value.client.clientSecret !== "string") ||
    typeof value.refreshToken !== "string" ||
    value.refreshToken.length === 0 ||
    typeof value.scope !== "string" ||
    value.scope.length === 0
  ) {
    throw new GoogleOAuthError("INVALID_STORED_CREDENTIAL", "Stored Google OAuth credential is invalid.");
  }
  try {
    validateClient(value.client as unknown as GoogleOAuthClient);
  } catch (error) {
    throw new GoogleOAuthError(
      "INVALID_STORED_CREDENTIAL",
      "Stored Google OAuth credential is invalid.",
      { cause: error },
    );
  }
}

function copyClient(client: GoogleOAuthClient): GoogleOAuthClient {
  return client.clientSecret === undefined
    ? {
        clientId: client.clientId,
        authorizationEndpoint: client.authorizationEndpoint,
        tokenEndpoint: client.tokenEndpoint,
      }
    : {
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        authorizationEndpoint: client.authorizationEndpoint,
        tokenEndpoint: client.tokenEndpoint,
      };
}

function requiredString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function optionalString(value: unknown): string | undefined {
  return value === undefined ? undefined : requiredString(value);
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function base64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
