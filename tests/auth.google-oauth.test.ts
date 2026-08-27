import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  GOOGLE_MAIL_SCOPE,
  FetchGmailProfileTransport,
  FetchOAuthRevocationTransport,
  GoogleOAuthError,
  GoogleOAuthFlow,
  parseGoogleOAuthClientJson,
  parseGoogleOAuthCallbackUrl,
  parseGoogleOAuthCredential,
  serializeGoogleOAuthCredential,
  type GoogleOAuthClient,
  type OAuthCallbackListener,
  type OAuthTokenTransport,
} from "../src/auth/index.js";

const CLIENT: GoogleOAuthClient = {
  clientId: "desktop-client.apps.googleusercontent.com",
  clientSecret: "client-secret",
  authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenEndpoint: "https://oauth2.googleapis.com/token",
};

test("parses only a valid Google installed-desktop client configuration", () => {
  assert.deepEqual(
    parseGoogleOAuthClientJson(
      JSON.stringify({
        installed: {
          client_id: CLIENT.clientId,
          client_secret: CLIENT.clientSecret,
          auth_uri: CLIENT.authorizationEndpoint,
          token_uri: CLIENT.tokenEndpoint,
          redirect_uris: ["http://localhost"],
        },
      }),
    ),
    CLIENT,
  );

  for (const malformed of [
    "not-json",
    "{}",
    JSON.stringify({ web: { client_id: "web-client" } }),
    JSON.stringify({ installed: { client_id: "", token_uri: CLIENT.tokenEndpoint } }),
    JSON.stringify({
      installed: { client_id: CLIENT.clientId, token_uri: "http://tokens.example.test" },
    }),
  ]) {
    assert.throws(
      () => parseGoogleOAuthClientJson(malformed),
      (error: unknown) =>
        error instanceof GoogleOAuthError && error.code === "INVALID_CLIENT_CONFIG",
    );
  }
});

test("uses state and S256 PKCE, exchanges the callback code, and stores no access token", async () => {
  const listener = new FakeCallbackListener();
  const tokenTransport = new RecordingTokenTransport({
    access_token: "short-lived-access-token",
    refresh_token: "long-lived-refresh-token",
    expires_in: 3600,
    token_type: "Bearer",
    scope: GOOGLE_MAIL_SCOPE,
  });
  let openedUrl = "";
  let randomCall = 0;
  const flow = new GoogleOAuthFlow({
    browserOpener: async (url) => {
      openedUrl = url;
    },
    callbackListenerFactory: async () => listener,
    tokenTransport,
    gmailProfileTransport: { async getEmail() { return "me@gmail.com"; } },
    randomBytes: (size) => new Uint8Array(size).fill(++randomCall),
    now: () => 1_000_000,
  });

  const result = await flow.authorize(CLIENT);
  const authorization = new URL(openedUrl);
  assert.deepEqual(authorization.searchParams.get("scope")?.split(" "), [GOOGLE_MAIL_SCOPE]);
  assert.equal(authorization.searchParams.has("include_granted_scopes"), false);
  assert.equal(authorization.searchParams.get("access_type"), "offline");
  assert.equal(authorization.searchParams.get("prompt"), "consent");
  assert.equal(authorization.searchParams.get("state"), listener.expectedState);
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");

  const verifier = Buffer.alloc(64, 2).toString("base64url");
  const expectedChallenge = createHash("sha256").update(verifier).digest("base64url");
  assert.equal(authorization.searchParams.get("code_challenge"), expectedChallenge);
  assert.equal(tokenTransport.parameters?.get("code"), "authorization-code");
  assert.equal(tokenTransport.parameters?.get("code_verifier"), verifier);
  assert.equal(tokenTransport.parameters?.get("client_secret"), CLIENT.clientSecret);
  assert.equal(result.token.accessToken, "short-lived-access-token");
  assert.equal(result.token.expiresAt.toISOString(), "1970-01-01T01:16:40.000Z");
  assert.equal(result.credential.refreshToken, "long-lived-refresh-token");
  assert.equal(result.accountEmail, "me@gmail.com");
  assert.equal(listener.closed, true);

  const serialized = serializeGoogleOAuthCredential(result.credential);
  assert.doesNotMatch(serialized, /short-lived-access-token/u);
  assert.deepEqual(parseGoogleOAuthCredential(serialized), result.credential);
});

test("returns the authorized account and refresh-token expiry without storing access tokens", async () => {
  const flow = new GoogleOAuthFlow({
    browserOpener: async () => undefined,
    callbackListenerFactory: async () => new FakeCallbackListener(),
    tokenTransport: new RecordingTokenTransport({
      access_token: "temporary-access-token",
      refresh_token: "temporary-refresh-token",
      refresh_token_expires_in: 604800,
      expires_in: 3600,
    }),
    gmailProfileTransport: { async getEmail() { return "ME@GMAIL.COM"; } },
    now: () => 1_000,
  });

  const result = await flow.authorize(CLIENT);
  assert.equal(result.accountEmail, "ME@GMAIL.COM");
  assert.equal(result.refreshTokenExpiresAt?.getTime(), 604_801_000);
});

test("looks up the authorized email through the read-only Gmail profile endpoint", async () => {
  let requestedUrl = "";
  const controller = new AbortController();
  const transport = new FetchGmailProfileTransport((async (input, init) => {
    requestedUrl = String(input);
    assert.equal(init?.headers && "authorization" in init.headers
      ? init.headers.authorization
      : undefined, "Bearer access-token");
    assert.equal(init?.signal, controller.signal);
    return new Response(JSON.stringify({ emailAddress: "  ME@GMAIL.COM  " }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch);

  assert.equal(await transport.getEmail("access-token", controller.signal), "me@gmail.com");
  assert.equal(
    requestedUrl,
    "https://gmail.googleapis.com/gmail/v1/users/me/profile?fields=emailAddress",
  );
});

test("rejects failed, malformed, and cancelled Gmail profile lookups", async () => {
  for (const response of [
    new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }),
    new Response(JSON.stringify({ emailAddress: "" }), { status: 200 }),
    new Response("not-json", { status: 200 }),
  ]) {
    const transport = new FetchGmailProfileTransport(
      (async () => response) as typeof globalThis.fetch,
    );
    await assert.rejects(transport.getEmail("access-token", new AbortController().signal));
  }

  const controller = new AbortController();
  const transport = new FetchGmailProfileTransport((async (_input, init) =>
    await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    })) as typeof globalThis.fetch);
  const pending = transport.getEmail("access-token", controller.signal);
  controller.abort(new Error("cancelled"));
  await assert.rejects(pending, /cancelled/u);
});

test("revokes unexpected broader grants before rejecting authorization", async () => {
  let revokedToken = "";
  const flow = new GoogleOAuthFlow({
    browserOpener: async () => undefined,
    callbackListenerFactory: async () => new FakeCallbackListener(),
    tokenTransport: new RecordingTokenTransport({
      access_token: "temporary-access-token",
      refresh_token: "overprivileged-refresh-token",
      expires_in: 3600,
      scope: `${GOOGLE_MAIL_SCOPE} https://mail.google.com/`,
    }),
    revocationTransport: {
      async revoke(token) {
        revokedToken = token;
        return "revoked";
      },
    },
  });

  await assert.rejects(
    flow.authorize(CLIENT),
    (error: unknown) =>
      error instanceof GoogleOAuthError && error.code === "UNEXPECTED_SCOPE",
  );
  assert.equal(revokedToken, "overprivileged-refresh-token");
});

test("token revocation is retryable for invalid tokens and redacts failures", async () => {
  const credential = {
    kind: "google-oauth" as const,
    version: 1 as const,
    client: CLIENT,
    refreshToken: "do-not-print-this-token",
    scope: "https://mail.google.com/",
  };
  const alreadyInvalid = new GoogleOAuthFlow({
    revocationTransport: { async revoke() { return "already-invalid"; } },
  });
  await alreadyInvalid.revoke(credential);

  const failing = new GoogleOAuthFlow({
    revocationTransport: { async revoke() { throw new Error("network unavailable"); } },
  });
  await assert.rejects(failing.revoke(credential), (error: unknown) => {
    assert.ok(error instanceof GoogleOAuthError);
    assert.equal(error.code, "TOKEN_REVOCATION_FAILED");
    assert.doesNotMatch(error.message, /do-not-print-this-token/u);
    return true;
  });
});

test("default revocation transport posts tokens and accepts invalid-token retries", async () => {
  const statuses = [200, 400, 503];
  const bodies: string[] = [];
  const transport = new FetchOAuthRevocationTransport((async (input, init) => {
    assert.equal(String(input), "https://oauth2.googleapis.com/revoke");
    bodies.push(String(init?.body));
    return new Response(null, { status: statuses.shift() });
  }) as typeof globalThis.fetch);
  const signal = new AbortController().signal;

  assert.equal(await transport.revoke("first-token", signal), "revoked");
  assert.equal(await transport.revoke("second-token", signal), "already-invalid");
  await assert.rejects(transport.revoke("third-token", signal), /HTTP 503/u);
  assert.deepEqual(bodies, ["token=first-token", "token=second-token", "token=third-token"]);
});

test("always closes the callback listener after a callback error", async () => {
  const listener = new FakeCallbackListener(
    new GoogleOAuthError("AUTHORIZATION_DENIED", "Authorization denied."),
  );
  const flow = new GoogleOAuthFlow({
    browserOpener: async () => undefined,
    callbackListenerFactory: async () => listener,
    tokenTransport: new RecordingTokenTransport({}),
  });

  await assert.rejects(
    flow.authorize(CLIENT),
    (error: unknown) =>
      error instanceof GoogleOAuthError && error.code === "AUTHORIZATION_DENIED",
  );
  assert.equal(listener.closed, true);
});

test("times out and closes a callback listener that never completes", async () => {
  const listener = new HangingCallbackListener();
  const flow = new GoogleOAuthFlow({
    browserOpener: async () => undefined,
    callbackListenerFactory: async () => listener,
    tokenTransport: new RecordingTokenTransport({}),
    timeoutMs: 5,
  });

  await assert.rejects(
    flow.authorize(CLIENT),
    (error: unknown) => error instanceof GoogleOAuthError && error.code === "CALLBACK_TIMEOUT",
  );
  assert.equal(listener.closed, true);
});

test("loopback callback parsing rejects state mismatches and provider errors", () => {
  assert.throws(
    () =>
      parseGoogleOAuthCallbackUrl(
        "http://127.0.0.1/oauth2/callback?state=wrong-state&code=secret-code",
        "expected-state",
      ),
    (error: unknown) => error instanceof GoogleOAuthError && error.code === "STATE_MISMATCH",
  );
  assert.throws(
    () =>
      parseGoogleOAuthCallbackUrl(
        "http://127.0.0.1/oauth2/callback?state=expected-state&error=access_denied",
        "expected-state",
      ),
    (error: unknown) =>
      error instanceof GoogleOAuthError && error.code === "AUTHORIZATION_DENIED",
  );
  assert.deepEqual(
    parseGoogleOAuthCallbackUrl(
      "http://127.0.0.1/oauth2/callback?state=expected-state&code=authorization-code",
      "expected-state",
    ),
    { code: "authorization-code" },
  );
});

test("refresh retains or rotates the refresh token and detects revoked grants", async () => {
  const credential = {
    kind: "google-oauth" as const,
    version: 1 as const,
    client: CLIENT,
    refreshToken: "original-refresh-token",
    scope: GOOGLE_MAIL_SCOPE,
  };
  const successfulTransport = new RecordingTokenTransport({
    access_token: "new-access-token",
    expires_in: 120,
    token_type: "Bearer",
  });
  const flow = new GoogleOAuthFlow({
    tokenTransport: successfulTransport,
    now: () => 10_000,
  });

  const refreshed = await flow.refresh(credential);
  assert.equal(refreshed.credential.refreshToken, "original-refresh-token");
  assert.equal(refreshed.token.accessToken, "new-access-token");
  assert.equal(successfulTransport.parameters?.get("grant_type"), "refresh_token");
  assert.equal(successfulTransport.parameters?.get("refresh_token"), "original-refresh-token");

  const revokedFlow = new GoogleOAuthFlow({
    tokenTransport: new RecordingTokenTransport({
      error: "invalid_grant",
      error_description: "Token has been expired or revoked.",
    }),
  });
  await assert.rejects(
    revokedFlow.refresh(credential),
    (error: unknown) => error instanceof GoogleOAuthError && error.code === "TOKEN_REVOKED",
  );
});

test("rejects malformed stored credentials without exposing their contents", () => {
  const secret = "do-not-print-this-secret";
  assert.throws(
    () => parseGoogleOAuthCredential(JSON.stringify({ refreshToken: secret })),
    (error: unknown) => {
      assert.ok(error instanceof GoogleOAuthError);
      assert.equal(error.code, "INVALID_STORED_CREDENTIAL");
      assert.doesNotMatch(error.message, new RegExp(secret, "u"));
      return true;
    },
  );
});

class FakeCallbackListener implements OAuthCallbackListener {
  readonly redirectUri = "http://127.0.0.1:54321/oauth2/callback";
  expectedState = "";
  closed = false;

  constructor(private readonly outcome: Error | undefined = undefined) {}

  async waitForCallback(expectedState: string): Promise<{ code: string }> {
    this.expectedState = expectedState;
    if (this.outcome !== undefined) throw this.outcome;
    return { code: "authorization-code" };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class RecordingTokenTransport implements OAuthTokenTransport {
  endpoint: string | undefined;
  parameters: URLSearchParams | undefined;

  constructor(private readonly response: unknown) {}

  async postForm(endpoint: string, parameters: URLSearchParams): Promise<unknown> {
    this.endpoint = endpoint;
    this.parameters = new URLSearchParams(parameters);
    return this.response;
  }
}

class HangingCallbackListener implements OAuthCallbackListener {
  readonly redirectUri = "http://127.0.0.1:54321/oauth2/callback";
  closed = false;

  waitForCallback(_expectedState: string, signal: AbortSignal): Promise<{ code: string }> {
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
