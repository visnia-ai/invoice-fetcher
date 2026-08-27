import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

import {
  defaultApplicationConfigDirectory,
  pathForPlatform,
  requireSupportedPlatform,
} from "../platform.js";

import {
  ACCOUNT_PROVIDERS,
  type AccountProfile,
  type AccountProvider,
  normalizeAccountEmail,
  type TlsMode,
} from "./types.js";

interface ProfileDocument {
  readonly version: 1;
  readonly profiles: readonly AccountProfile[];
}

export interface AccountProfileStore {
  list(): Promise<readonly AccountProfile[]>;
  get(email: string): Promise<AccountProfile | undefined>;
  put(profile: AccountProfile, replace?: boolean): Promise<void>;
  remove(email: string): Promise<AccountProfile | undefined>;
}

export class AccountProfileError extends Error {
  override readonly name = "AccountProfileError";
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

function requireString(record: Record<string, unknown>, name: string): string {
  const value = record[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new AccountProfileError(`Account profile has an invalid ${name}.`);
  }
  return value;
}

function parseProfile(value: unknown): AccountProfile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AccountProfileError("Account profile must be an object.");
  }
  const record = value as Record<string, unknown>;
  const email = normalizeAccountEmail(requireString(record, "email"));
  if (!EMAIL_PATTERN.test(email)) {
    throw new AccountProfileError("Account profile has an invalid email.");
  }
  const provider = requireString(record, "provider");
  if (!(ACCOUNT_PROVIDERS as readonly string[]).includes(provider)) {
    throw new AccountProfileError("Account profile has an invalid provider.");
  }
  const host = requireString(record, "host");
  const username = requireString(record, "username");
  const port = record.port;
  if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65_535) {
    throw new AccountProfileError("Account profile has an invalid port.");
  }
  const tls = record.tls;
  if (tls !== "implicit" && tls !== "starttls") {
    throw new AccountProfileError("Account profile has an invalid TLS mode.");
  }
  if (record.version !== 1) {
    throw new AccountProfileError("Account profile uses an unsupported version.");
  }

  if (
    provider === "google" &&
    (host !== "imap.gmail.com" || port !== 993 || tls !== "implicit")
  ) {
    throw new AccountProfileError("Google account profile has invalid server settings.");
  }
  return {
    version: 1,
    email,
    provider: provider as AccountProvider,
    host,
    port: port as number,
    tls: tls as TlsMode,
    username,
  } as AccountProfile;
}

function parseDocument(text: string): ProfileDocument {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error: unknown) {
    throw new AccountProfileError(
      `Could not parse the account profile file: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AccountProfileError("Account profile file must contain an object.");
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || !Array.isArray(record.profiles)) {
    throw new AccountProfileError("Account profile file has an unsupported format.");
  }
  const profiles = record.profiles.map(parseProfile);
  const emails = new Set<string>();
  for (const profile of profiles) {
    if (emails.has(profile.email)) {
      throw new AccountProfileError(`Duplicate account profile for ${profile.email}.`);
    }
    emails.add(profile.email);
  }
  return { version: 1, profiles };
}

export function defaultProfilePath(
  homeDirectory?: string,
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return pathForPlatform(requireSupportedPlatform(platform)).join(
    defaultApplicationConfigDirectory({ platform, homeDirectory, environment }),
    "profiles.json",
  );
}

export class JsonAccountProfileStore implements AccountProfileStore {
  constructor(readonly filePath = defaultProfilePath()) {}

  async list(): Promise<readonly AccountProfile[]> {
    return (await this.read()).profiles;
  }

  async get(email: string): Promise<AccountProfile | undefined> {
    const normalized = normalizeAccountEmail(email);
    return (await this.list()).find((profile) => profile.email === normalized);
  }

  async put(profile: AccountProfile, replace = false): Promise<void> {
    const normalizedProfile = parseProfile(profile);
    const profiles = [...(await this.list())];
    const index = profiles.findIndex((candidate) => candidate.email === normalizedProfile.email);
    if (index >= 0 && !replace) {
      throw new AccountProfileError(
        `An account for ${normalizedProfile.email} already exists; pass --replace to replace it.`,
      );
    }
    if (index >= 0) profiles[index] = normalizedProfile;
    else profiles.push(normalizedProfile);
    profiles.sort((left, right) => left.email.localeCompare(right.email));
    await this.write({ version: 1, profiles });
  }

  async remove(email: string): Promise<AccountProfile | undefined> {
    const normalized = normalizeAccountEmail(email);
    const profiles = [...(await this.list())];
    const index = profiles.findIndex((profile) => profile.email === normalized);
    if (index < 0) return undefined;
    const [removed] = profiles.splice(index, 1);
    await this.write({ version: 1, profiles });
    return removed;
  }

  private async read(): Promise<ProfileDocument> {
    try {
      return parseDocument(await readFile(this.filePath, "utf8"));
    } catch (error: unknown) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return { version: 1, profiles: [] };
      }
      throw error;
    }
  }

  private async write(document: ProfileDocument): Promise<void> {
    const directory = path.dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, this.filePath);
    } finally {
      await handle?.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
    }
  }
}
