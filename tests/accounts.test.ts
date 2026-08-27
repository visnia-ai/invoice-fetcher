import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  AccountCommandError,
  AccountCommandService,
  type AccountCredentialStore,
  type AccountProfile,
  type AccountProfileStore,
  createImapAccountSetup,
  createAccountCredentialStore,
  CredentialStoreError,
  JsonAccountProfileStore,
  KeychainError,
  MacOsKeychainCredentialStore,
  NativeCredentialStore,
  type NativeCredentialEntry,
  parseAccountCommand,
  type SecurityCommandRunner,
  TerminalAccountPrompt,
} from "../src/accounts/index.js";

function googleProfile(email = "me@example.com"): AccountProfile {
  return {
    version: 1,
    email,
    provider: "google",
    host: "imap.gmail.com",
    port: 993,
    tls: "implicit",
    username: email,
  };
}

test("JSON profile store normalizes, sorts, replaces, removes, and uses private permissions", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "invoice-fetcher-accounts-"));
  const profilePath = path.join(directory, "nested", "profiles.json");
  const store = new JsonAccountProfileStore(profilePath);

  await store.put(googleProfile("ZED@Example.com"));
  await store.put({
    version: 1,
    email: "amy@example.com",
    provider: "imap",
    host: "mail.example.com",
    port: 993,
    tls: "implicit",
    username: "amy@example.com",
  });

  assert.deepEqual(
    (await store.list()).map((profile) => profile.email),
    ["amy@example.com", "zed@example.com"],
  );
  assert.equal((await store.get("Zed@EXAMPLE.com"))?.provider, "google");
  await assert.rejects(() => store.put(googleProfile("zed@example.com")), /--replace/u);

  await store.put(
    {
      version: 1,
      email: "zed@example.com",
      provider: "imap",
      host: "mail.example.com",
      port: 143,
      tls: "starttls",
      username: "zed",
    },
    true,
  );
  assert.equal((await store.get("zed@example.com"))?.provider, "imap");
  assert.equal((await store.remove("amy@example.com"))?.provider, "imap");
  assert.equal(await store.get("amy@example.com"), undefined);
  if (process.platform !== "win32") {
    assert.equal((await stat(profilePath)).mode & 0o777, 0o600);
  }

  const persisted = await readFile(profilePath, "utf8");
  assert.doesNotMatch(persisted, /password|token|secret/iu);
});

test("JSON profile store rejects malformed and provider-inconsistent documents", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "invoice-fetcher-accounts-bad-"));
  const profilePath = path.join(directory, "profiles.json");
  const store = new JsonAccountProfileStore(profilePath);

  await writeFile(profilePath, "not JSON", "utf8");
  await assert.rejects(() => store.list(), /Could not parse/u);

  await writeFile(
    profilePath,
    JSON.stringify({
      version: 1,
      profiles: [
        {
          version: 1,
          email: "person@icloud.com",
          provider: "icloud",
          host: "imap.mail.me.com",
          port: 993,
          tls: "implicit",
          username: "person@icloud.com",
        },
      ],
    }),
    "utf8",
  );
  await assert.rejects(() => store.list(), /invalid provider/u);

  await writeFile(
    profilePath,
    JSON.stringify({
      version: 1,
      profiles: [
        {
          ...googleProfile(),
          host: "evil.example.com",
        },
      ],
    }),
    "utf8",
  );
  await assert.rejects(() => store.list(), /Google account profile/u);
});

test("Keychain store writes non-interactively over stdin and never exposes credentials in argv", async () => {
  const calls: Array<{ args: readonly string[]; stdin?: string }> = [];
  const runner: SecurityCommandRunner = async (args, stdin) => {
    calls.push({ args, ...(stdin === undefined ? {} : { stdin }) });
    if (args[0] === "find-generic-password") {
      return { exitCode: 0, stdout: "opaque-token\n", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const store = new MacOsKeychainCredentialStore(runner, "test-service");

  await store.set("Me@Example.com", "google", "very-secret");
  assert.equal(
    calls[0]?.stdin,
    'add-generic-password -a "google:me@example.com" -s "test-service" -U -X "766572792d736563726574"\n',
  );
  assert.deepEqual(calls[0]?.args, ["-i"]);
  assert.equal(calls[0]?.args.includes("very-secret"), false);
  assert.equal(calls[0]?.stdin?.includes("very-secret"), false);
  assert.equal(calls[0]?.stdin?.includes("-w"), false);
  assert.equal(await store.get("me@example.com", "google"), "opaque-token");
  await store.delete("me@example.com", "google");
});

test("Keychain store treats exit 44 as absent and redacts credential failures", async () => {
  const missing = new MacOsKeychainCredentialStore(async () => ({
    exitCode: 44,
    stdout: "",
    stderr: "not found",
  }));
  assert.equal(await missing.get("me@example.com", "imap"), undefined);
  await missing.delete("me@example.com", "imap");

  const failing = new MacOsKeychainCredentialStore(async () => ({
    exitCode: 1,
    stdout: "",
    stderr: "access denied",
  }));
  await assert.rejects(
    () => failing.set("me@example.com", "imap", "DO-NOT-PRINT"),
    (error: unknown) => error instanceof KeychainError && !error.message.includes("DO-NOT-PRINT"),
  );
});

function nativeEntryFactory(options: {
  password?: string | null;
  getError?: Error;
  setError?: Error;
  deleteError?: Error;
}) {
  const calls: Array<{ service: string; account: string; credential?: string }> = [];
  const factory = (service: string, account: string): NativeCredentialEntry => ({
    getPassword: async () => {
      calls.push({ service, account });
      if (options.getError !== undefined) throw options.getError;
      return options.password;
    },
    setPassword: async (credential: string) => {
      calls.push({ service, account, credential });
      if (options.setError !== undefined) throw options.setError;
      options.password = credential;
    },
    deleteCredential: async () => {
      calls.push({ service, account });
      if (options.deleteError !== undefined) throw options.deleteError;
      const deleted = options.password != null;
      options.password = null;
      return deleted;
    },
  });
  return { calls, factory };
}

test("native credential store normalizes identifiers and supports get/set/delete", async () => {
  const native = nativeEntryFactory({ password: null });
  const store = new NativeCredentialStore("win32", native.factory, "test-service");

  assert.equal(await store.get("Me@Example.com", "google"), undefined);
  await store.set("Me@Example.com", "google", "opaque-token");
  assert.equal(await store.get("me@example.com", "google"), "opaque-token");
  await store.delete("ME@example.com", "google");
  assert.equal(await store.get("me@example.com", "google"), undefined);
  assert.equal(native.calls.every((call) => call.service === "test-service"), true);
  assert.equal(native.calls.every((call) => call.account === "google:me@example.com"), true);
});

test("native credential store treats NoEntry as absent and redacts failures", async () => {
  const missing = nativeEntryFactory({ getError: new Error("NoEntry") });
  const missingStore = new NativeCredentialStore("linux", missing.factory);
  assert.equal(await missingStore.get("me@example.com", "imap"), undefined);

  const codedMissing = new Error("credential was not found") as Error & { code: string };
  codedMissing.code = "NoEntry";
  const missingDelete = nativeEntryFactory({ deleteError: codedMissing });
  await new NativeCredentialStore("win32", missingDelete.factory).delete(
    "me@example.com",
    "imap",
  );

  const secret = "DO-NOT-PRINT";
  const failing = nativeEntryFactory({ setError: new Error(`denied ${secret}`) });
  await assert.rejects(
    () => new NativeCredentialStore("linux", failing.factory).set("me@example.com", "imap", secret),
    (error: unknown) =>
      error instanceof CredentialStoreError &&
      /Linux Secret Service.*GNOME Keyring.*D-Bus/u.test(error.message) &&
      !error.message.includes(secret),
  );
});

test("credential store factory chooses the platform backend and rejects unsupported systems", () => {
  assert.ok(createAccountCredentialStore("darwin") instanceof MacOsKeychainCredentialStore);
  assert.ok(createAccountCredentialStore("linux") instanceof NativeCredentialStore);
  assert.ok(createAccountCredentialStore("win32") instanceof NativeCredentialStore);
  assert.throws(() => createAccountCredentialStore("freebsd"), CredentialStoreError);
  assert.throws(() => new NativeCredentialStore("darwin"), CredentialStoreError);
});

test("account command parser recognizes add/list/remove and validates provider flags", () => {
  assert.deepEqual(parseAccountCommand(["list"]), { kind: "list" });
  assert.deepEqual(parseAccountCommand(["remove", "ME@Example.com"]), {
    kind: "remove",
    email: "me@example.com",
  });
  assert.deepEqual(
    parseAccountCommand([
      "add",
      "google",
      "ME@Example.com",
      "--replace",
    ]),
    {
      kind: "add",
      provider: "google",
      email: "me@example.com",
      replace: true,
    },
  );
  assert.equal(parseAccountCommand(["2026-01-01"]), undefined);
  assert.deepEqual(
    parseAccountCommand(["add", "google", "me@example.com"]),
    {
      kind: "add",
      provider: "google",
      email: "me@example.com",
      replace: false,
    },
  );
  assert.throws(
    () => parseAccountCommand(["add", "icloud", "me@example.com"]),
    /Unsupported account provider: icloud/u,
  );
  assert.throws(
    () => parseAccountCommand(["add", "google", "me@example.com", "--oauth-client"]),
    /Unknown account option: --oauth-client/u,
  );
});

class MemoryProfiles implements AccountProfileStore {
  profiles = new Map<string, AccountProfile>();
  async list(): Promise<readonly AccountProfile[]> {
    return [...this.profiles.values()];
  }
  async get(email: string): Promise<AccountProfile | undefined> {
    return this.profiles.get(email.toLowerCase());
  }
  async put(profile: AccountProfile, replace = false): Promise<void> {
    if (this.profiles.has(profile.email) && !replace) throw new Error("exists");
    this.profiles.set(profile.email, profile);
  }
  async remove(email: string): Promise<AccountProfile | undefined> {
    const profile = this.profiles.get(email);
    this.profiles.delete(email);
    return profile;
  }
}

class MemoryCredentials implements AccountCredentialStore {
  credentials = new Map<string, string>();
  async get(email: string, provider: AccountProfile["provider"]): Promise<string | undefined> {
    return this.credentials.get(`${provider}:${email}`);
  }
  async set(
    email: string,
    provider: AccountProfile["provider"],
    credential: string,
  ): Promise<void> {
    this.credentials.set(`${provider}:${email}`, credential);
  }
  async delete(email: string, provider: AccountProfile["provider"]): Promise<void> {
    this.credentials.delete(`${provider}:${email}`);
  }
}

test("account command service keeps secrets out of output and enforces replacement", async () => {
  const profiles = new MemoryProfiles();
  const credentials = new MemoryCredentials();
  const setup = async () => ({ profile: googleProfile(), credential: "TOP-SECRET" });
  const service = new AccountCommandService(profiles, credentials, {
    google: setup,
    imap: setup,
  });
  const add = parseAccountCommand(["add", "google", "me@example.com"]);
  assert.ok(add);
  const result = await service.execute(add);
  assert.doesNotMatch(result.lines.join(""), /TOP-SECRET/u);
  assert.deepEqual(result.lines, ["Successfully set up me@example.com!"]);
  assert.equal(credentials.credentials.get("google:me@example.com"), "TOP-SECRET");
  await assert.rejects(() => service.execute(add), /--replace/u);

  assert.deepEqual((await service.execute({ kind: "list" })).lines, [
    "me@example.com\tgoogle",
  ]);
  assert.deepEqual((await service.execute({ kind: "remove", email: "me@example.com" })).lines, [
    "Removed me@example.com.",
  ]);
  assert.equal(credentials.credentials.size, 0);
  await assert.rejects(
    () => service.execute({ kind: "remove", email: "me@example.com" }),
    AccountCommandError,
  );
});

test("prompted IMAP setup returns a safe profile and opaque credentials", async () => {
  const values = ["mail.example.com", "starttls", "143", "mail-user"];
  const prompt = {
    input: async (_label: string, defaultValue?: string) => values.shift() ?? defaultValue ?? "",
    secret: async () => "app-password",
  };
  const command = {
    kind: "add" as const,
    provider: "imap" as const,
    email: "me@example.com",
    replace: false,
  };
  const imap = await createImapAccountSetup(prompt)(command);
  assert.deepEqual(imap.profile, {
    version: 1,
    email: "me@example.com",
    provider: "imap",
    host: "mail.example.com",
    port: 143,
    tls: "starttls",
    username: "mail-user",
  });
  assert.equal(imap.credential, "app-password");
});

test("terminal prompt applies defaults and never writes secret answers", async () => {
  const defaultInput = new PassThrough();
  const defaultOutput = new PassThrough();
  let defaultWritten = "";
  defaultOutput.setEncoding("utf8");
  defaultOutput.on("data", (chunk: string) => {
    defaultWritten += chunk;
  });
  const defaultPrompt = new TerminalAccountPrompt({
    input: defaultInput,
    output: defaultOutput,
  });
  const defaultAnswer = defaultPrompt.input("IMAP port", "993");
  defaultInput.end("\n");
  assert.equal(await defaultAnswer, "993");
  assert.match(defaultWritten, /IMAP port \[993\]:/u);

  const secretInput = new PassThrough();
  const secretOutput = new PassThrough();
  let secretWritten = "";
  secretOutput.setEncoding("utf8");
  secretOutput.on("data", (chunk: string) => {
    secretWritten += chunk;
  });
  const secretPrompt = new TerminalAccountPrompt({
    input: secretInput,
    output: secretOutput,
  });
  const secretAnswer = secretPrompt.secret("Password");
  secretInput.end("DO-NOT-ECHO\n");
  assert.equal(await secretAnswer, "DO-NOT-ECHO");
  assert.match(secretWritten, /Password:/u);
  assert.doesNotMatch(secretWritten, /DO-NOT-ECHO/u);
});
