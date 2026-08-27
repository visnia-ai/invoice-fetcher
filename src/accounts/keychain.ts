import { spawn } from "node:child_process";

import { AsyncEntry } from "@napi-rs/keyring";

import { normalizeAccountEmail, type AccountProvider } from "./types.js";

export interface AccountCredentialStore {
  get(email: string, provider: AccountProvider): Promise<string | undefined>;
  set(email: string, provider: AccountProvider, credential: string): Promise<void>;
  delete(email: string, provider: AccountProvider): Promise<void>;
}

export interface SecurityCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type SecurityCommandRunner = (
  args: readonly string[],
  stdin?: string,
) => Promise<SecurityCommandResult>;

export class CredentialStoreError extends Error {
  override readonly name: string = "CredentialStoreError";
}

/** @deprecated Prefer CredentialStoreError for platform-independent error handling. */
export class KeychainError extends CredentialStoreError {
  override readonly name = "KeychainError";
}

export const runSecurityCommand: SecurityCommandRunner = (args, stdin) =>
  new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/security", args, {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (exitCode) => {
      resolve({ exitCode: exitCode ?? 1, stdout, stderr });
    });
    child.stdin.end(stdin);
  });

const NOT_FOUND_EXIT_CODE = 44;

export class MacOsKeychainCredentialStore implements AccountCredentialStore {
  constructor(
    private readonly runner: SecurityCommandRunner = runSecurityCommand,
    private readonly service = "invoice-fetcher",
  ) {}

  async get(email: string, provider: AccountProvider): Promise<string | undefined> {
    const result = await this.runner([
      "find-generic-password",
      "-a",
      this.accountName(email, provider),
      "-s",
      this.service,
      "-w",
    ]);
    if (result.exitCode === NOT_FOUND_EXIT_CODE) return undefined;
    if (result.exitCode !== 0) throw this.failure("read", result);
    return result.stdout.replace(/\r?\n$/u, "");
  }

  async set(email: string, provider: AccountProvider, credential: string): Promise<void> {
    if (credential.includes("\0")) {
      throw new KeychainError("A credential cannot contain a null character.");
    }
    // `security add-generic-password -w` prompts on the controlling terminal even
    // when stdin is piped. Interactive mode accepts the complete command over
    // stdin instead, while -X prevents a password-data prompt. The credential is
    // hex-encoded only for the security command parser; it never enters argv.
    const command = [
      "add-generic-password",
      "-a",
      quoteSecurityArgument(this.accountName(email, provider)),
      "-s",
      quoteSecurityArgument(this.service),
      "-U",
      "-X",
      quoteSecurityArgument(Buffer.from(credential, "utf8").toString("hex")),
    ].join(" ");
    const result = await this.runner(
      ["-i"],
      `${command}\n`,
    );
    if (result.exitCode !== 0) throw this.failure("store", result);
  }

  async delete(email: string, provider: AccountProvider): Promise<void> {
    const result = await this.runner([
      "delete-generic-password",
      "-a",
      this.accountName(email, provider),
      "-s",
      this.service,
    ]);
    if (result.exitCode !== 0 && result.exitCode !== NOT_FOUND_EXIT_CODE) {
      throw this.failure("delete", result);
    }
  }

  private accountName(email: string, provider: AccountProvider): string {
    return `${provider}:${normalizeAccountEmail(email)}`;
  }

  private failure(action: string, result: SecurityCommandResult): KeychainError {
    const detail = result.stderr.trim();
    return new KeychainError(
      `Could not ${action} account credentials in macOS Keychain${detail ? `: ${detail}` : "."}`,
    );
  }
}

export interface NativeCredentialEntry {
  getPassword(): Promise<string | null | undefined>;
  setPassword(password: string): Promise<void>;
  deleteCredential(): Promise<boolean>;
}

export type NativeCredentialEntryFactory = (
  service: string,
  account: string,
) => NativeCredentialEntry;

const createNativeCredentialEntry: NativeCredentialEntryFactory = (service, account) =>
  new AsyncEntry(service, account);

/**
 * Stores credentials in Windows Credential Manager or Linux Secret Service.
 * macOS intentionally keeps using the security CLI store above so existing
 * invoice-fetcher Keychain entries remain compatible.
 */
export class NativeCredentialStore implements AccountCredentialStore {
  constructor(
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly entryFactory: NativeCredentialEntryFactory = createNativeCredentialEntry,
    private readonly service = "invoice-fetcher",
  ) {
    if (platform !== "linux" && platform !== "win32") {
      throw new CredentialStoreError(
        `Native credential storage is not supported on platform ${platform}.`,
      );
    }
  }

  async get(email: string, provider: AccountProvider): Promise<string | undefined> {
    try {
      return (await this.entry(email, provider).getPassword()) ?? undefined;
    } catch (error: unknown) {
      if (isMissingCredentialError(error)) return undefined;
      throw this.failure("read");
    }
  }

  async set(email: string, provider: AccountProvider, credential: string): Promise<void> {
    if (credential.includes("\0")) {
      throw new CredentialStoreError("A credential cannot contain a null character.");
    }
    try {
      await this.entry(email, provider).setPassword(credential);
    } catch {
      throw this.failure("store");
    }
  }

  async delete(email: string, provider: AccountProvider): Promise<void> {
    try {
      await this.entry(email, provider).deleteCredential();
    } catch (error: unknown) {
      if (isMissingCredentialError(error)) return;
      throw this.failure("delete");
    }
  }

  private entry(email: string, provider: AccountProvider): NativeCredentialEntry {
    return this.entryFactory(this.service, `${provider}:${normalizeAccountEmail(email)}`);
  }

  private failure(action: string): CredentialStoreError {
    if (this.platform === "linux") {
      return new CredentialStoreError(
        `Could not ${action} account credentials in Linux Secret Service. ` +
          "Ensure a Secret Service provider such as GNOME Keyring or KWallet is installed, " +
          "unlocked, and available in this desktop session (including D-Bus).",
      );
    }
    return new CredentialStoreError(
      `Could not ${action} account credentials in Windows Credential Manager. ` +
        "Ensure Credential Manager is available and the current user can access it.",
    );
  }
}

export function createAccountCredentialStore(
  platform: NodeJS.Platform = process.platform,
): AccountCredentialStore {
  if (platform === "darwin") return new MacOsKeychainCredentialStore();
  if (platform === "linux" || platform === "win32") {
    return new NativeCredentialStore(platform);
  }
  throw new CredentialStoreError(
    `Secure credential storage is not supported on platform ${platform}.`,
  );
}

function isMissingCredentialError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
  return code === "NoEntry" || error.message === "NoEntry";
}

function quoteSecurityArgument(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
