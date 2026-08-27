import {
  AccountCommandService,
  AccountCommandError,
  type AccountCredentialStore,
  type AccountProfile,
  type AccountProfileStore,
  type AccountPrompt,
  createAccountCredentialStore,
  createImapAccountSetup,
  JsonAccountProfileStore,
  normalizeAccountEmail,
  TerminalAccountPrompt,
} from "./accounts/index.js";
import {
  createGmailImapAuth,
  GoogleOAuthFlow,
  GoogleCloudOAuthSetup,
  hasExactGoogleMailScope,
  type GoogleCloudOAuthSetupService,
  type GoogleOAuthClient,
  parseGoogleOAuthCredential,
  serializeGoogleOAuthCredential,
  type GoogleOAuthStoredCredential,
  type GoogleRefreshResult,
} from "./auth/index.js";
import type {
  GmailApiClientFactory,
  GmailApiConnectionProfile,
  GmailApiProfileResolver,
} from "./gmail/types.js";
import { GmailApiMailSource } from "./gmail/gmail-mail-source.js";
import {
  ImapMailSource,
  type ImapClientFactory,
  type ImapConnectionProfile,
  type ImapProfileResolver,
} from "./imap/index.js";
import {
  ProviderRoutingMailSource,
  type MailProviderResolver,
} from "./mail/provider-routing-source.js";
import { MailSourceError, type MailSource } from "./mail/types.js";

export interface RuntimeServices {
  readonly accountCommands: AccountCommandService;
  readonly mailSource: MailSource;
}

export interface RuntimeDependencies {
  readonly profiles?: AccountProfileStore;
  readonly credentials?: AccountCredentialStore;
  readonly prompt?: AccountPrompt;
  readonly googleOAuth?: GoogleOAuthFlow;
  readonly googleCloudSetup?: GoogleCloudOAuthSetupService;
  readonly writeStatus?: (message: string) => void;
  readonly gmailClientFactory?: GmailApiClientFactory;
  readonly imapClientFactory?: ImapClientFactory;
}

let defaultRuntimeServices: RuntimeServices | undefined;

export function getDefaultRuntimeServices(): RuntimeServices {
  defaultRuntimeServices ??= createRuntimeServices();
  return defaultRuntimeServices;
}

/** Creates the real platform-backed account and mail services used by the CLI. */
export function createRuntimeServices(
  dependencies: RuntimeDependencies = {},
): RuntimeServices {
  const profiles = dependencies.profiles ?? new JsonAccountProfileStore();
  const credentials = dependencies.credentials ?? createAccountCredentialStore();
  const prompt = dependencies.prompt ?? new TerminalAccountPrompt();
  const googleOAuth = dependencies.googleOAuth ?? new GoogleOAuthFlow();
  const googleCloudSetup =
    dependencies.googleCloudSetup ?? new GoogleCloudOAuthSetup(prompt);
  const writeStatus =
    dependencies.writeStatus ?? ((message: string) => process.stderr.write(`${message}\n`));

  const imapSetup = createImapAccountSetup(prompt);
  const accountCommands = new AccountCommandService(profiles, credentials, {
    imap: imapSetup,
    google: async (command) => {
      const existingValue = command.replace
        ? await credentials.get(command.email, "google")
        : undefined;
      let existingCredential: GoogleOAuthStoredCredential | undefined;
      if (existingValue !== undefined) {
        try {
          existingCredential = parseGoogleOAuthCredential(existingValue);
        } catch (error) {
          throw new AccountCommandError(
            "The stored Google authorization is invalid and cannot be revoked automatically. Remove Invoice Fetcher access in your Google Account, then remove and add the account again.",
            { cause: error },
          );
        }
      }
      const client: GoogleOAuthClient =
        existingCredential?.client ?? await googleCloudSetup.provision(command.email);
      if (
        existingCredential !== undefined &&
        !hasExactGoogleMailScope(existingCredential.scope)
      ) {
        writeStatus("Revoking the previous full-access Google authorization...");
        await googleOAuth.revoke(existingCredential);
      }
      writeStatus(
        "Complete the authentication in your browser to finalize the setup. Make sure to close the browser window when authentication is completed.",
      );
      const authorization = await googleOAuth.authorize(client, command.email);
      if (normalizeAccountEmail(authorization.accountEmail) !== command.email) {
        throw new AccountCommandError(
          `Google authorized ${authorization.accountEmail}, but ${command.email} was requested. Retry and choose the requested account.`,
        );
      }
      if (authorization.refreshTokenExpiresAt !== undefined) {
        throw new AccountCommandError(
          "Google issued a time-limited refresh token. Publish the OAuth app to In production, then add the account again.",
        );
      }
      return {
        profile: {
          version: 1,
          provider: "google",
          email: command.email,
          username: command.email,
          host: "imap.gmail.com",
          port: 993,
          tls: "implicit",
        },
        credential: serializeGoogleOAuthCredential(authorization.credential),
      };
    },
  });

  const resolveProfile = createConfiguredProfileResolver(
    profiles,
    credentials,
    googleOAuth,
  );
  const imapSource = new ImapMailSource(resolveProfile, {
    ...(dependencies.imapClientFactory
      ? { clientFactory: dependencies.imapClientFactory }
      : {}),
  });
  const gmailSource = new GmailApiMailSource(
    createConfiguredGmailApiProfileResolver(profiles, credentials, googleOAuth),
    {
      ...(dependencies.gmailClientFactory
        ? { clientFactory: dependencies.gmailClientFactory }
        : {}),
    },
  );
  return {
    accountCommands,
    mailSource: new ProviderRoutingMailSource(
      createConfiguredProviderResolver(profiles),
      { google: gmailSource, imap: imapSource },
    ),
  };
}

export function createConfiguredProfileResolver(
  profiles: AccountProfileStore,
  credentials: AccountCredentialStore,
  googleOAuth: GoogleOAuthFlow,
): ImapProfileResolver {
  return async (requestedEmail) => {
    const email = normalizeAccountEmail(requestedEmail);
    const profile = await profiles.get(email);
    if (!profile) {
      throw new MailSourceError(
        "ACCOUNT_NOT_FOUND",
        `No configured account exists for ${email}. Run 'invoice-fetcher add <provider> ${email}' first.`,
      );
    }
    const stored = await credentials.get(profile.email, profile.provider);
    if (stored === undefined) {
      throw new MailSourceError(
        "MAIL_ACCESS_FAILED",
        `Credentials for ${profile.email} are missing. Add the account again with --replace.`,
      );
    }
    return await resolveConnectionProfile(profile, stored, credentials, googleOAuth);
  };
}

export function createConfiguredProviderResolver(
  profiles: AccountProfileStore,
): MailProviderResolver {
  return async (requestedEmail) => {
    const email = normalizeAccountEmail(requestedEmail);
    const profile = await profiles.get(email);
    if (!profile) {
      throw new MailSourceError(
        "ACCOUNT_NOT_FOUND",
        `No configured account exists for ${email}. Run 'invoice-fetcher add <provider> ${email}' first.`,
      );
    }
    return profile.provider;
  };
}

export function createConfiguredGmailApiProfileResolver(
  profiles: AccountProfileStore,
  credentials: AccountCredentialStore,
  googleOAuth: GoogleOAuthFlow,
): GmailApiProfileResolver {
  return async (requestedEmail): Promise<GmailApiConnectionProfile> => {
    const email = normalizeAccountEmail(requestedEmail);
    const profile = await profiles.get(email);
    if (!profile) {
      throw new MailSourceError(
        "ACCOUNT_NOT_FOUND",
        `No configured account exists for ${email}. Run 'invoice-fetcher add <provider> ${email}' first.`,
      );
    }
    if (profile.provider !== "google") {
      throw new MailSourceError(
        "INVALID_REQUEST",
        `${email} is not configured as a Google account.`,
      );
    }
    const stored = await credentials.get(profile.email, profile.provider);
    if (stored === undefined) {
      throw new MailSourceError(
        "MAIL_ACCESS_FAILED",
        `Credentials for ${profile.email} are missing. Add the account again with --replace.`,
      );
    }
    const credential = parseGoogleOAuthCredential(stored);
    const refreshed = await refreshGoogleCredential(
      profile.email,
      credential,
      credentials,
      googleOAuth,
    );
    return {
      email: profile.email,
      accessToken: refreshed.token.accessToken,
      expiresAt: refreshed.token.expiresAt,
      tokenType: refreshed.token.tokenType,
      scope: refreshed.token.scope,
      oauthClient: {
        clientId: credential.client.clientId,
        ...(credential.client.clientSecret
          ? { clientSecret: credential.client.clientSecret }
          : {}),
      },
    };
  };
}

async function resolveConnectionProfile(
  profile: AccountProfile,
  storedCredential: string,
  credentials: AccountCredentialStore,
  googleOAuth: GoogleOAuthFlow,
): Promise<ImapConnectionProfile> {
  if (profile.provider === "google") {
    const refreshed = await refreshGoogleCredential(
      profile.email,
      parseGoogleOAuthCredential(storedCredential),
      credentials,
      googleOAuth,
    );
    const authentication = createGmailImapAuth(profile.email, refreshed.token);
    return {
      provider: profile.provider,
      email: profile.email,
      host: profile.host,
      port: profile.port,
      tls: profile.tls,
      username: authentication.username,
      authentication: { type: "oauth2", accessToken: authentication.accessToken },
    };
  }

  if (storedCredential.length === 0) {
    throw new MailSourceError("MAIL_ACCESS_FAILED", "Stored IMAP credentials are empty.");
  }
  return {
    provider: profile.provider,
    email: profile.email,
    host: profile.host,
    port: profile.port,
    tls: profile.tls,
    username: profile.username,
    authentication: { type: "password", password: storedCredential },
  };
}

async function refreshGoogleCredential(
  email: string,
  credential: GoogleOAuthStoredCredential,
  credentials: AccountCredentialStore,
  googleOAuth: GoogleOAuthFlow,
): Promise<GoogleRefreshResult> {
  if (!hasExactGoogleMailScope(credential.scope)) {
    throw new MailSourceError(
      "MAIL_ACCESS_FAILED",
      `Google permissions for ${email} must be migrated to read-only access. Run 'invoice-fetcher add google ${email} --replace'.`,
    );
  }
  const refreshed = await googleOAuth.refresh(credential);
  await credentials.set(
    email,
    "google",
    serializeGoogleOAuthCredential(refreshed.credential),
  );
  return refreshed;
}
