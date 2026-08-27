import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import type {
  AccountCredentialStore,
  AccountProfile,
  AccountProfileStore,
  AccountProvider,
} from "../src/accounts/index.js";
import {
  GOOGLE_MAIL_SCOPE,
  GoogleOAuthFlow,
  serializeGoogleOAuthCredential,
  type GoogleOAuthClient,
  type OAuthRevocationTransport,
} from "../src/auth/index.js";
import { MailSourceError } from "../src/mail/index.js";
import type { GmailApiClient } from "../src/gmail/types.js";
import type { ImapClient } from "../src/imap/types.js";
import {
  createConfiguredGmailApiProfileResolver,
  createConfiguredProviderResolver,
  createConfiguredProfileResolver,
  createRuntimeServices,
} from "../src/runtime.js";

class MemoryProfiles implements AccountProfileStore {
  constructor(readonly profiles: AccountProfile[]) {}
  async list(): Promise<readonly AccountProfile[]> {
    return this.profiles;
  }
  async get(email: string): Promise<AccountProfile | undefined> {
    return this.profiles.find((profile) => profile.email === email.toLowerCase());
  }
  async put(profile: AccountProfile): Promise<void> {
    this.profiles.push(profile);
  }
  async remove(email: string): Promise<AccountProfile | undefined> {
    const index = this.profiles.findIndex((profile) => profile.email === email);
    return index < 0 ? undefined : this.profiles.splice(index, 1)[0];
  }
}

class MemoryCredentials implements AccountCredentialStore {
  readonly values = new Map<string, string>();
  async get(email: string, provider: AccountProvider): Promise<string | undefined> {
    return this.values.get(`${provider}:${email}`);
  }
  async set(email: string, provider: AccountProvider, credential: string): Promise<void> {
    this.values.set(`${provider}:${email}`, credential);
  }
  async delete(email: string, provider: AccountProvider): Promise<void> {
    this.values.delete(`${provider}:${email}`);
  }
}

const imapProfile: AccountProfile = {
  version: 1,
  provider: "imap",
  email: "me@example.com",
  host: "mail.example.com",
  port: 143,
  tls: "starttls",
  username: "mailbox-user",
};

const TEST_GOOGLE_CLIENT: GoogleOAuthClient = {
  clientId: "123456789-desktop.apps.googleusercontent.com",
  clientSecret: "client-secret",
  authorizationEndpoint: "https://accounts.example/authorize",
  tokenEndpoint: "https://accounts.example/token",
};

test("configured resolver loads generic IMAP credentials", async () => {
  const profiles = new MemoryProfiles([imapProfile]);
  const credentials = new MemoryCredentials();
  credentials.values.set("imap:me@example.com", "imap-password");
  const resolver = createConfiguredProfileResolver(
    profiles,
    credentials,
    new GoogleOAuthFlow(),
  );

  assert.deepEqual((await resolver("ME@example.com")).authentication, {
    type: "password",
    password: "imap-password",
  });
});

test("configured resolver refreshes Google OAuth and persists rotated credentials", async () => {
  const google: AccountProfile = {
    version: 1,
    provider: "google",
    email: "me@gmail.com",
    host: "imap.gmail.com",
    port: 993,
    tls: "implicit",
    username: "me@gmail.com",
  };
  const profiles = new MemoryProfiles([google]);
  const credentials = new MemoryCredentials();
  credentials.values.set(
    "google:me@gmail.com",
    serializeGoogleOAuthCredential({
      kind: "google-oauth",
      version: 1,
      client: {
        clientId: "desktop-client",
        authorizationEndpoint: "https://accounts.example/authorize",
        tokenEndpoint: "https://accounts.example/token",
      },
      refreshToken: "old-refresh",
      scope: GOOGLE_MAIL_SCOPE,
    }),
  );
  const oauth = new GoogleOAuthFlow({
    tokenTransport: {
      async postForm() {
        return {
          access_token: "memory-only-access-token",
          expires_in: 3600,
          refresh_token: "rotated-refresh",
        };
      },
    },
    gmailProfileTransport: {
      async getEmail() {
        return "me@gmail.com";
      },
    },
  });
  const resolved = await createConfiguredProfileResolver(
    profiles,
    credentials,
    oauth,
  )("me@gmail.com");

  assert.deepEqual(resolved.authentication, {
    type: "oauth2",
    accessToken: "memory-only-access-token",
  });
  assert.match(credentials.values.get("google:me@gmail.com") ?? "", /rotated-refresh/u);
  assert.doesNotMatch(
    credentials.values.get("google:me@gmail.com") ?? "",
    /memory-only-access-token/u,
  );
});

test("Gmail API resolver returns only a memory access profile and rotates credentials", async () => {
  const google: AccountProfile = {
    version: 1,
    provider: "google",
    email: "me@gmail.com",
    host: "imap.gmail.com",
    port: 993,
    tls: "implicit",
    username: "me@gmail.com",
  };
  const profiles = new MemoryProfiles([google]);
  const credentials = new MemoryCredentials();
  credentials.values.set(
    "google:me@gmail.com",
    serializeGoogleOAuthCredential({
      kind: "google-oauth",
      version: 1,
      client: TEST_GOOGLE_CLIENT,
      refreshToken: "old-refresh",
      scope: GOOGLE_MAIL_SCOPE,
    }),
  );
  const oauth = new GoogleOAuthFlow({
    tokenTransport: {
      async postForm() {
        return {
          access_token: "memory-only-access-token",
          expires_in: 3600,
          refresh_token: "rotated-refresh",
          token_type: "Bearer",
          scope: GOOGLE_MAIL_SCOPE,
        };
      },
    },
  });

  const resolved = await createConfiguredGmailApiProfileResolver(
    profiles,
    credentials,
    oauth,
  )("ME@gmail.com");

  assert.equal(resolved.email, "me@gmail.com");
  assert.equal(resolved.accessToken, "memory-only-access-token");
  assert.equal(resolved.oauthClient.clientId, TEST_GOOGLE_CLIENT.clientId);
  assert.equal(resolved.oauthClient.clientSecret, TEST_GOOGLE_CLIENT.clientSecret);
  assert.match(credentials.values.get("google:me@gmail.com") ?? "", /rotated-refresh/u);
  assert.doesNotMatch(
    credentials.values.get("google:me@gmail.com") ?? "",
    /memory-only-access-token/u,
  );
});

test("Gmail API resolver refuses to refresh legacy broad-scope credentials", async () => {
  const google: AccountProfile = {
    version: 1,
    provider: "google",
    email: "me@gmail.com",
    host: "imap.gmail.com",
    port: 993,
    tls: "implicit",
    username: "me@gmail.com",
  };
  const profiles = new MemoryProfiles([google]);
  const credentials = new MemoryCredentials();
  credentials.values.set(
    "google:me@gmail.com",
    serializeGoogleOAuthCredential({
      kind: "google-oauth",
      version: 1,
      client: TEST_GOOGLE_CLIENT,
      refreshToken: "legacy-refresh",
      scope:
        "https://mail.google.com/ https://www.googleapis.com/auth/userinfo.email",
    }),
  );
  let refreshCalls = 0;
  const oauth = new GoogleOAuthFlow({
    tokenTransport: {
      async postForm() {
        refreshCalls += 1;
        throw new Error("legacy credentials must not be refreshed");
      },
    },
  });

  await assert.rejects(
    createConfiguredGmailApiProfileResolver(profiles, credentials, oauth)("me@gmail.com"),
    (error: unknown) =>
      error instanceof MailSourceError &&
      error.code === "MAIL_ACCESS_FAILED" &&
      error.message.includes("invoice-fetcher add google me@gmail.com --replace"),
  );
  assert.equal(refreshCalls, 0);
});

test("configured provider resolver selects stored account providers", async () => {
  const profiles = new MemoryProfiles([
    imapProfile,
    {
      version: 1,
      provider: "google",
      email: "me@gmail.com",
      host: "imap.gmail.com",
      port: 993,
      tls: "implicit",
      username: "me@gmail.com",
    },
  ]);
  const resolver = createConfiguredProviderResolver(profiles);

  assert.equal(await resolver("ME@EXAMPLE.COM"), "imap");
  assert.equal(await resolver("me@gmail.com"), "google");
  await assert.rejects(
    resolver("absent@example.com"),
    (error: unknown) => error instanceof MailSourceError && error.code === "ACCOUNT_NOT_FOUND",
  );
});

test("runtime routes Google exclusively to Gmail API and generic accounts to IMAP", async () => {
  const directory = await mkdtemp(join(tmpdir(), "invoice-fetcher-routing-"));
  try {
    const googleProfile: AccountProfile = {
      version: 1,
      provider: "google",
      email: "me@gmail.com",
      host: "imap.gmail.com",
      port: 993,
      tls: "implicit",
      username: "me@gmail.com",
    };
    const profiles = new MemoryProfiles([googleProfile, imapProfile]);
    const credentials = new MemoryCredentials();
    credentials.values.set(
      "google:me@gmail.com",
      serializeGoogleOAuthCredential({
        kind: "google-oauth",
        version: 1,
        client: TEST_GOOGLE_CLIENT,
        refreshToken: "refresh",
        scope: GOOGLE_MAIL_SCOPE,
      }),
    );
    credentials.values.set("imap:me@example.com", "password");
    const oauth = new GoogleOAuthFlow({
      tokenTransport: {
        async postForm() {
          return { access_token: "access", expires_in: 3600 };
        },
      },
    });
    let gmailFactories = 0;
    let imapFactories = 0;
    const gmailClient: GmailApiClient = {
      async getProfile() { return { emailAddress: "me@gmail.com" }; },
      async listMessages() { return { messageIds: [] }; },
      async getMessage() { throw new Error("no messages"); },
      async getRawMessage() { throw new Error("no messages"); },
      async getAttachment() { throw new Error("no messages"); },
    };
    const imapClient: ImapClient = {
      async connect() {},
      async listMailboxes() { return []; },
      async lockMailbox() { return { release() {} }; },
      async searchReceived() { return []; },
      async fetchMetadataBatch() { return []; },
      async downloadMessage() { return Readable.from([]); },
      async downloadPart() { return { content: Readable.from([]) }; },
      async logout() {},
    };
    const runtime = createRuntimeServices({
      profiles,
      credentials,
      googleOAuth: oauth,
      gmailClientFactory: () => {
        gmailFactories += 1;
        return gmailClient;
      },
      imapClientFactory: () => {
        imapFactories += 1;
        return imapClient;
      },
    });
    const base = {
      startInclusive: new Date("2026-07-01T00:00:00Z"),
      endExclusive: new Date("2026-07-11T00:00:00Z"),
      stagingDirectory: directory,
      keywords: ["invoice"],
    };

    assert.equal((await runtime.mailSource.search({
      ...base,
      accountEmail: "me@gmail.com",
    })).scannedMessages, 0);
    assert.deepEqual({ gmailFactories, imapFactories }, { gmailFactories: 1, imapFactories: 0 });

    assert.equal((await runtime.mailSource.search({
      ...base,
      accountEmail: "me@example.com",
    })).scannedMessages, 0);
    assert.equal(gmailFactories, 1);
    assert.ok(imapFactories >= 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("configured resolver gives actionable missing-account and credential errors", async () => {
  const profiles = new MemoryProfiles([imapProfile]);
  const credentials = new MemoryCredentials();
  const resolver = createConfiguredProfileResolver(
    profiles,
    credentials,
    new GoogleOAuthFlow(),
  );

  await assert.rejects(
    resolver("absent@example.com"),
    (error: unknown) => error instanceof MailSourceError && error.code === "ACCOUNT_NOT_FOUND",
  );
  await assert.rejects(
    resolver("me@example.com"),
    (error: unknown) =>
      error instanceof MailSourceError &&
      error.code === "MAIL_ACCESS_FAILED" &&
      error.message.includes("--replace"),
  );
});

test("runtime Google account setup authorizes and stores only the refresh credential", async () => {
  const profiles = new MemoryProfiles([]);
  const credentials = new MemoryCredentials();
  const statuses: string[] = [];
  let openedUrl = "";
  const oauth = new GoogleOAuthFlow({
    browserOpener: async (url) => {
      openedUrl = url;
    },
    callbackListenerFactory: async () => ({
      redirectUri: "http://127.0.0.1:4567/oauth2/callback",
      async waitForCallback() {
        return { code: "authorization-code" };
      },
      async close() {},
    }),
    tokenTransport: {
      async postForm() {
        return {
          access_token: "temporary-access",
          refresh_token: "long-lived-refresh",
          expires_in: 3600,
        };
      },
    },
    gmailProfileTransport: {
      async getEmail() {
        return "me@gmail.com";
      },
    },
  });
  const runtime = createRuntimeServices({
    profiles,
    credentials,
    writeStatus: (message) => statuses.push(message),
    googleOAuth: oauth,
    googleCloudSetup: {
      async provision() {
        return {
          clientId: "desktop-client",
          authorizationEndpoint: "https://accounts.example/authorize",
          tokenEndpoint: "https://accounts.example/token",
        };
      },
    },
    prompt: {
      async input(_label, defaultValue) {
        return defaultValue ?? "";
      },
      async secret() {
        return "unused";
      },
    },
  });

  const result = await runtime.accountCommands.execute({
    kind: "add",
    provider: "google",
    email: "me@gmail.com",
    replace: false,
  });

  assert.deepEqual(result.lines, ["Successfully set up me@gmail.com!"]);
  assert.deepEqual(statuses, [
    "Complete the authentication in your browser to finalize the setup. Make sure to close the browser window when authentication is completed.",
  ]);
  assert.equal(new URL(openedUrl).searchParams.get("login_hint"), "me@gmail.com");
  assert.match(openedUrl, /code_challenge_method=S256/u);
  assert.equal(profiles.profiles[0]?.provider, "google");
  const stored = credentials.values.get("google:me@gmail.com") ?? "";
  assert.match(stored, /long-lived-refresh/u);
  assert.doesNotMatch(stored, /temporary-access/u);
});

test("runtime provisions a client when omitted and reuses the Keychain client on replace", async () => {
  const profiles = new MemoryProfiles([]);
  const credentials = new MemoryCredentials();
  let provisionCalls = 0;
  const googleCloudSetup = {
    async provision(email: string) {
      provisionCalls += 1;
      assert.equal(email, "me@gmail.com");
      return TEST_GOOGLE_CLIENT;
    },
  };
  const runtime = createRuntimeServices({
    profiles,
    credentials,
    googleCloudSetup,
    googleOAuth: testAuthorizationFlow("me@gmail.com"),
  });

  await runtime.accountCommands.execute({
    kind: "add",
    provider: "google",
    email: "me@gmail.com",
    replace: false,
  });
  assert.equal(provisionCalls, 1);

  const replacement = createRuntimeServices({
    profiles,
    credentials,
    googleCloudSetup: {
      async provision() {
        throw new Error("must reuse the stored OAuth client");
      },
    },
    googleOAuth: testAuthorizationFlow("me@gmail.com"),
  });
  await replacement.accountCommands.execute({
    kind: "add",
    provider: "google",
    email: "me@gmail.com",
    replace: true,
  });
  assert.match(credentials.values.get("google:me@gmail.com") ?? "", /long-lived-refresh/u);
});

test("runtime replacement revokes a legacy Google grant before read-only authorization", async () => {
  const profiles = new MemoryProfiles([{
    version: 1,
    provider: "google",
    email: "me@gmail.com",
    host: "imap.gmail.com",
    port: 993,
    tls: "implicit",
    username: "me@gmail.com",
  }]);
  const credentials = new MemoryCredentials();
  credentials.values.set(
    "google:me@gmail.com",
    serializeGoogleOAuthCredential({
      kind: "google-oauth",
      version: 1,
      client: TEST_GOOGLE_CLIENT,
      refreshToken: "legacy-refresh",
      scope: "https://mail.google.com/",
    }),
  );
  const revoked: string[] = [];
  const statuses: string[] = [];
  const runtime = createRuntimeServices({
    profiles,
    credentials,
    writeStatus: (message) => statuses.push(message),
    googleCloudSetup: {
      async provision() {
        throw new Error("must reuse the stored OAuth client");
      },
    },
    googleOAuth: testAuthorizationFlow("me@gmail.com", {}, {
      async revoke(refreshToken) {
        revoked.push(refreshToken);
        return "revoked";
      },
    }),
  });

  await runtime.accountCommands.execute({
    kind: "add",
    provider: "google",
    email: "me@gmail.com",
    replace: true,
  });

  assert.deepEqual(revoked, ["legacy-refresh"]);
  assert.equal(statuses[0], "Revoking the previous full-access Google authorization...");
  const stored = credentials.values.get("google:me@gmail.com") ?? "";
  assert.match(stored, /long-lived-refresh/u);
  assert.match(stored, new RegExp(GOOGLE_MAIL_SCOPE.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  assert.doesNotMatch(stored, /mail\.google\.com/u);
});

test("runtime aborts legacy migration when revocation fails and remains retryable", async () => {
  const profiles = new MemoryProfiles([{
    version: 1,
    provider: "google",
    email: "me@gmail.com",
    host: "imap.gmail.com",
    port: 993,
    tls: "implicit",
    username: "me@gmail.com",
  }]);
  const credentials = new MemoryCredentials();
  const legacy = serializeGoogleOAuthCredential({
    kind: "google-oauth",
    version: 1,
    client: TEST_GOOGLE_CLIENT,
    refreshToken: "legacy-refresh",
    scope: "https://mail.google.com/",
  });
  credentials.values.set("google:me@gmail.com", legacy);
  let browserOpened = false;
  const oauth = new GoogleOAuthFlow({
    browserOpener: async () => { browserOpened = true; },
    revocationTransport: {
      async revoke() {
        throw new Error("revocation service unavailable");
      },
    },
  });
  const runtime = createRuntimeServices({ profiles, credentials, googleOAuth: oauth });

  await assert.rejects(
    runtime.accountCommands.execute({
      kind: "add",
      provider: "google",
      email: "me@gmail.com",
      replace: true,
    }),
    /could not revoke the previous Google authorization/iu,
  );
  assert.equal(browserOpened, false);
  assert.equal(credentials.values.get("google:me@gmail.com"), legacy);
});

test("runtime rejects the wrong Google account and time-limited refresh tokens", async () => {
  for (const oauth of [
    testAuthorizationFlow("other@gmail.com"),
    testAuthorizationFlow("me@gmail.com", { refresh_token_expires_in: 604800 }),
  ]) {
    const profiles = new MemoryProfiles([]);
    const credentials = new MemoryCredentials();
    const runtime = createRuntimeServices({
      profiles,
      credentials,
      googleOAuth: oauth,
      googleCloudSetup: { async provision() { return TEST_GOOGLE_CLIENT; } },
    });
    await assert.rejects(
      runtime.accountCommands.execute({
        kind: "add",
        provider: "google",
        email: "me@gmail.com",
        replace: false,
      }),
      /was requested|time-limited refresh token/u,
    );
    assert.equal(profiles.profiles.length, 0);
    assert.equal(credentials.values.size, 0);
  }
});

function testAuthorizationFlow(
  accountEmail: string,
  tokenExtras: Readonly<Record<string, unknown>> = {},
  revocationTransport?: OAuthRevocationTransport,
): GoogleOAuthFlow {
  return new GoogleOAuthFlow({
    browserOpener: async () => undefined,
    callbackListenerFactory: async () => ({
      redirectUri: "http://127.0.0.1:4567/oauth2/callback",
      async waitForCallback() {
        return { code: "authorization-code" };
      },
      async close() {},
    }),
    tokenTransport: {
      async postForm() {
        return {
          access_token: "temporary-access",
          refresh_token: "long-lived-refresh",
          expires_in: 3600,
          ...tokenExtras,
        };
      },
    },
    gmailProfileTransport: { async getEmail() { return accountEmail; } },
    ...(revocationTransport ? { revocationTransport } : {}),
  });
}
