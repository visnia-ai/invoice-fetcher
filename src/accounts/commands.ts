import {
  type AccountCredentialStore,
  CredentialStoreError,
} from "./keychain.js";
import {
  AccountProfileError,
  type AccountProfileStore,
} from "./profile-store.js";
import {
  isAccountProvider,
  type AccountProfile,
  type AccountProvider,
  normalizeAccountEmail,
  type TlsMode,
} from "./types.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export const ACCOUNT_USAGE = `Usage:
  invoice-fetcher add imap <email> [--replace]
  invoice-fetcher add google <email> [--oauth-client <client-json>] [--replace]
  invoice-fetcher list
  invoice-fetcher remove <email>`;

export interface AddAccountCommand {
  readonly kind: "add";
  readonly provider: AccountProvider;
  readonly email: string;
  readonly replace: boolean;
  readonly oauthClientPath?: string;
}

export type AccountCommand =
  | AddAccountCommand
  | { readonly kind: "list" }
  | { readonly kind: "remove"; readonly email: string };

export interface AccountSetupResult {
  readonly profile: AccountProfile;
  /** Opaque serialized provider credentials. Never display or persist in profiles. */
  readonly credential: string;
}

export type AccountSetup = (command: AddAccountCommand) => Promise<AccountSetupResult>;

export interface AccountCommandResult {
  readonly lines: readonly string[];
}

export class AccountCommandError extends Error {
  override readonly name = "AccountCommandError";
}

function validEmail(value: string): string {
  const normalized = normalizeAccountEmail(value);
  if (!EMAIL_PATTERN.test(normalized)) {
    throw new AccountCommandError("Account email must be a valid email address.");
  }
  return normalized;
}

export function parseAccountCommand(argv: readonly string[]): AccountCommand | undefined {
  if (argv.length === 1 && argv[0] === "list") return { kind: "list" };
  if (argv.length === 2 && argv[0] === "remove" && argv[1] !== undefined) {
    return { kind: "remove", email: validEmail(argv[1]) };
  }
  if (argv[0] !== "add") return undefined;
  if (argv[1] === undefined || argv[2] === undefined) {
    throw new AccountCommandError(ACCOUNT_USAGE);
  }
  const providerValue = argv[1];
  if (!isAccountProvider(providerValue)) {
    throw new AccountCommandError(`Unsupported account provider: ${providerValue}.`);
  }
  const email = validEmail(argv[2]);
  let replace = false;
  let oauthClientPath: string | undefined;
  for (let index = 3; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--replace") {
      if (replace) throw new AccountCommandError("--replace may only be passed once.");
      replace = true;
      continue;
    }
    if (argument === "--oauth-client") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new AccountCommandError("--oauth-client requires a client JSON path.");
      }
      if (oauthClientPath !== undefined) {
        throw new AccountCommandError("--oauth-client may only be passed once.");
      }
      oauthClientPath = value;
      index += 1;
      continue;
    }
    throw new AccountCommandError(`Unknown account option: ${argument ?? ""}.`);
  }
  if (providerValue !== "google" && oauthClientPath !== undefined) {
    throw new AccountCommandError("--oauth-client is only valid for Google accounts.");
  }
  return {
    kind: "add",
    provider: providerValue,
    email,
    replace,
    ...(oauthClientPath === undefined ? {} : { oauthClientPath }),
  };
}

export class AccountCommandService {
  constructor(
    private readonly profiles: AccountProfileStore,
    private readonly credentials: AccountCredentialStore,
    private readonly setups: Readonly<Record<AccountProvider, AccountSetup>>,
  ) {}

  async execute(command: AccountCommand): Promise<AccountCommandResult> {
    if (command.kind === "list") {
      const profiles = await this.profiles.list();
      return {
        lines:
          profiles.length === 0
            ? ["No configured accounts."]
            : profiles.map((profile) => `${profile.email}\t${profile.provider}`),
      };
    }
    if (command.kind === "remove") {
      const profile = await this.profiles.get(command.email);
      if (profile === undefined) {
        throw new AccountCommandError(`No configured account exists for ${command.email}.`);
      }
      await this.credentials.delete(profile.email, profile.provider);
      await this.profiles.remove(profile.email);
      return { lines: [`Removed ${profile.email}.`] };
    }

    const existing = await this.profiles.get(command.email);
    if (existing !== undefined && !command.replace) {
      throw new AccountCommandError(
        `An account for ${command.email} already exists; pass --replace to replace it.`,
      );
    }
    const setup = await this.setups[command.provider](command);
    if (normalizeAccountEmail(setup.profile.email) !== command.email) {
      throw new AccountCommandError("Account setup returned a profile for a different email.");
    }
    if (setup.profile.provider !== command.provider) {
      throw new AccountCommandError("Account setup returned a profile for a different provider.");
    }

    const priorCredential =
      existing === undefined
        ? undefined
        : await this.credentials.get(existing.email, existing.provider);
    let profileStored = false;
    try {
      await this.credentials.set(setup.profile.email, setup.profile.provider, setup.credential);
      await this.profiles.put(setup.profile, command.replace);
      profileStored = true;
      if (existing !== undefined && existing.provider !== setup.profile.provider) {
        await this.credentials.delete(existing.email, existing.provider);
      }
    } catch (error: unknown) {
      if (profileStored) {
        if (existing === undefined) await this.profiles.remove(setup.profile.email).catch(() => undefined);
        else await this.profiles.put(existing, true).catch(() => undefined);
      }
      await this.rollbackCredential(existing, priorCredential, setup.profile).catch(() => undefined);
      if (
        error instanceof AccountProfileError ||
        error instanceof CredentialStoreError ||
        error instanceof AccountCommandError
      ) {
        throw error;
      }
      throw new AccountCommandError(
        `Could not configure account: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return {
      lines: [
        setup.profile.provider === "google"
          ? `Successfully set up ${setup.profile.email}!`
          : `Configured ${setup.profile.email} (${setup.profile.provider}).`,
      ],
    };
  }

  private async rollbackCredential(
    existing: AccountProfile | undefined,
    priorCredential: string | undefined,
    replacement: AccountProfile,
  ): Promise<void> {
    await this.credentials.delete(replacement.email, replacement.provider);
    if (existing !== undefined && priorCredential !== undefined) {
      await this.credentials.set(existing.email, existing.provider, priorCredential);
    }
  }
}

export interface AccountPrompt {
  input(label: string, defaultValue?: string): Promise<string>;
  secret(label: string): Promise<string>;
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new AccountCommandError("IMAP port must be an integer between 1 and 65535.");
  }
  return port;
}

function parseTls(value: string): TlsMode {
  const normalized = value.trim().toLocaleLowerCase("en-US");
  if (normalized !== "implicit" && normalized !== "starttls") {
    throw new AccountCommandError("TLS mode must be implicit or starttls.");
  }
  return normalized;
}

export function createImapAccountSetup(prompt: AccountPrompt): AccountSetup {
  return async (command) => {
    const host = (await prompt.input("IMAP host")).trim();
    if (host.length === 0 || /[\s\0]/u.test(host)) {
      throw new AccountCommandError("IMAP host must be non-empty and contain no whitespace.");
    }
    const tls = parseTls(await prompt.input("TLS mode", "implicit"));
    const port = parsePort(await prompt.input("IMAP port", tls === "implicit" ? "993" : "143"));
    const username = (await prompt.input("IMAP username", command.email)).trim();
    if (username.length === 0) throw new AccountCommandError("IMAP username cannot be empty.");
    const password = await prompt.secret("IMAP password");
    if (password.length === 0) throw new AccountCommandError("IMAP password cannot be empty.");
    return {
      profile: {
        version: 1,
        email: command.email,
        provider: "imap",
        host,
        port,
        tls,
        username,
      },
      credential: password,
    };
  };
}
