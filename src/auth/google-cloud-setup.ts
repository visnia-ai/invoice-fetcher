import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

import type { AccountPrompt } from "../accounts/commands.js";
import { normalizeAccountEmail } from "../accounts/types.js";
import {
  defaultApplicationConfigDirectory,
  pathForPlatform,
  requireSupportedPlatform,
} from "../platform.js";
import { openInDefaultBrowser } from "./google-oauth.js";
import {
  GOOGLE_MAIL_SCOPE,
  type BrowserOpener,
  type GoogleOAuthClient,
} from "./types.js";
import {
  createGcloudCommandRunner,
  GcloudCliError,
  GcloudCliResolver,
  type GcloudCommandOptions,
  type GcloudCommandResult,
  type GcloudCommandRunner,
} from "./gcloud-cli.js";

export {
  type GcloudCommandOptions,
  type GcloudCommandResult,
  type GcloudCommandRunner,
  runGcloudCommand,
} from "./gcloud-cli.js";

const AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const CLOUD_TERMS_URL = "https://console.cloud.google.com/terms";
const PROJECT_ID = "invoice-fetcher-260826";

interface SetupStateDocument {
  readonly version: 1;
  readonly accounts: Readonly<Record<string, { readonly projectId: string }>>;
}

export function defaultGoogleCloudSetupStatePath(
  homeDirectory?: string,
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return pathForPlatform(requireSupportedPlatform(platform)).join(
    defaultApplicationConfigDirectory({ platform, homeDirectory, environment }),
    "google-cloud-setup.json",
  );
}

export class GoogleCloudSetupStateStore {
  constructor(readonly filePath = defaultGoogleCloudSetupStatePath()) {}

  async get(email: string): Promise<string | undefined> {
    return (await this.read()).accounts[normalizeAccountEmail(email)]?.projectId;
  }

  async put(email: string, projectId: string): Promise<void> {
    if (!isProjectId(projectId)) throw new GoogleCloudSetupError("Invalid Google Cloud project ID.");
    const current = await this.read();
    await this.write({
      version: 1,
      accounts: {
        ...current.accounts,
        [normalizeAccountEmail(email)]: { projectId },
      },
    });
  }

  private async read(): Promise<SetupStateDocument> {
    let text: string;
    try {
      text = await readFile(this.filePath, "utf8");
    } catch (error: unknown) {
      if (isErrorCode(error, "ENOENT")) return { version: 1, accounts: {} };
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch (error) {
      throw new GoogleCloudSetupError("Could not parse saved Google Cloud setup state.", {
        cause: error,
      });
    }
    if (!isObject(value) || value.version !== 1 || !isObject(value.accounts)) {
      throw new GoogleCloudSetupError("Saved Google Cloud setup state has an unsupported format.");
    }
    const accounts: Record<string, { projectId: string }> = {};
    for (const [email, entry] of Object.entries(value.accounts)) {
      if (!isObject(entry) || typeof entry.projectId !== "string" || !isProjectId(entry.projectId)) {
        throw new GoogleCloudSetupError("Saved Google Cloud setup state is invalid.");
      }
      accounts[normalizeAccountEmail(email)] = { projectId: entry.projectId };
    }
    return { version: 1, accounts };
  }

  private async write(document: SetupStateDocument): Promise<void> {
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

export class GoogleCloudSetupError extends Error {
  override readonly name = "GoogleCloudSetupError";
}

export interface GoogleCloudOAuthSetupService {
  provision(email: string): Promise<GoogleOAuthClient>;
}

export interface GoogleCloudOAuthSetupDependencies {
  readonly commandRunner?: GcloudCommandRunner;
  readonly stateStore?: GoogleCloudSetupStateStore;
  readonly browserOpener?: BrowserOpener;
  readonly fetch?: typeof globalThis.fetch;
  readonly isInteractive?: () => boolean;
  readonly writeStatus?: (message: string) => void;
}

export class GoogleCloudOAuthSetup implements GoogleCloudOAuthSetupService {
  private readonly commandRunner: GcloudCommandRunner;
  private readonly stateStore: GoogleCloudSetupStateStore;
  private readonly browserOpener: BrowserOpener;
  private readonly fetch: typeof globalThis.fetch;
  private readonly isInteractive: () => boolean;
  private readonly writeStatus: (message: string) => void;

  constructor(
    private readonly prompt: AccountPrompt,
    dependencies: GoogleCloudOAuthSetupDependencies = {},
  ) {
    this.writeStatus = dependencies.writeStatus ?? ((message) => process.stderr.write(`${message}\n`));
    this.commandRunner =
      dependencies.commandRunner ??
      createGcloudCommandRunner(
        new GcloudCliResolver({ writeStatus: this.writeStatus }),
      );
    this.stateStore = dependencies.stateStore ?? new GoogleCloudSetupStateStore();
    this.browserOpener = dependencies.browserOpener ?? openInDefaultBrowser;
    this.fetch = dependencies.fetch ?? globalThis.fetch;
    this.isInteractive =
      dependencies.isInteractive ??
      (() => process.stdin.isTTY === true && process.stdout.isTTY === true);
  }

  async provision(rawEmail: string): Promise<GoogleOAuthClient> {
    const email = normalizeAccountEmail(rawEmail);
    if (!this.isInteractive()) {
      throw new GoogleCloudSetupError(
        "Automatic Google setup requires an interactive terminal. Pass --oauth-client <client-json> instead.",
      );
    }
    await this.requireGcloud();
    await this.ensureGcloudAccount(email);
    const { projectId, projectNumber } = await this.ensureProject(email);
    await this.enableGmailApi(email, projectId);

    this.writeStatus(`Google Cloud project ready: ${projectId}`);
    const brandConfigured = await this.tryConfigureBrand(email, projectId);
    const internalAudience = await this.hasOrganizationParent(email, projectId);
    await this.guideConsoleSetup(email, projectId, brandConfigured, internalAudience);
    return await this.readClientCredentials(projectNumber);
  }

  private async requireGcloud(): Promise<void> {
    let result: GcloudCommandResult;
    try {
      result = await this.commandRunner(["version", "--format=json"]);
    } catch (error) {
      const message =
        error instanceof GcloudCliError
          ? error.message
          : "The Google Cloud CLI could not be prepared for automatic setup. Retry or pass --oauth-client <client-json>.";
      throw new GoogleCloudSetupError(
        message,
        { cause: error },
      );
    }
    if (result.exitCode !== 0) {
      const detail = commandDetail(result);
      const pythonMessage = /python|cloudsdk_python/iu.test(detail)
        ? " The Google Cloud CLI requires Python 3.10–3.14. Install a supported Python version, then retry."
        : "";
      throw new GoogleCloudSetupError(
        `The Google Cloud CLI could not run.${pythonMessage} You can also pass --oauth-client <client-json>.`,
      );
    }
  }

  private async ensureGcloudAccount(email: string): Promise<void> {
    if (await this.hasGcloudAccount(email)) return;
    await this.loginGcloudAccount(email);
  }

  private async loginGcloudAccount(email: string): Promise<void> {
    this.writeStatus(`Signing in to gcloud as ${email}...`);
    this.writeStatus(
      "Please sign in to your Google account in the browser window that just opened.",
    );
    const login = await this.commandRunner(
      ["auth", "login", email, "--force", "--no-activate", "--brief"],
      { inheritStdio: true },
    );
    if (login.exitCode !== 0 || !(await this.hasGcloudAccount(email))) {
      throw new GoogleCloudSetupError(`gcloud authentication did not complete for ${email}.`);
    }
  }

  private async hasGcloudAccount(email: string): Promise<boolean> {
    const result = await this.commandRunner([
      "auth",
      "list",
      `--filter=account=${email}`,
      "--format=value(account)",
    ]);
    if (result.exitCode !== 0) {
      throw new GoogleCloudSetupError("Could not inspect gcloud authentication state.");
    }
    return result.stdout
      .split(/\r?\n/u)
      .some((candidate) => normalizeAccountEmail(candidate) === email);
  }

  private async ensureProject(
    email: string,
  ): Promise<{ projectId: string; projectNumber: string }> {
    const projectId = PROJECT_ID;
    await this.stateStore.put(email, projectId);

    const described = await this.describeProject(email, projectId);
    if (described.kind === "found") {
      return { projectId, projectNumber: described.projectNumber };
    }
    if (described.kind === "error") {
      throw this.gcloudFailure("inspect the saved Google Cloud project", described.detail);
    }

    this.writeStatus(`Creating dedicated Google Cloud project ${projectId}...`);
    const created = await this.commandRunner([
      "projects",
      "create",
      projectId,
      "--name=Invoice Fetcher",
      `--account=${email}`,
      "--quiet",
    ]);
    if (created.exitCode === 0) {
      const confirmed = await this.describeProject(email, projectId);
      if (confirmed.kind === "found") {
        return { projectId, projectNumber: confirmed.projectNumber };
      }
      throw new GoogleCloudSetupError(
        `Google created ${projectId}, but invoice-fetcher could not read it yet. Rerun the command to resume setup.`,
      );
    }

    const detail = commandDetail(created);
    if (isProjectIdUnavailable(detail)) {
      throw new GoogleCloudSetupError(
        `The Google Cloud project ID ${projectId} is already in use and project IDs cannot be renamed.`,
      );
    }
    throw this.gcloudFailure("create the Google Cloud project", detail);
  }

  private async describeProject(
    email: string,
    projectId: string,
  ): Promise<
    | { readonly kind: "found"; readonly projectNumber: string }
    | { readonly kind: "missing" }
    | { readonly kind: "error"; readonly detail: string }
  > {
    const args = [
      "projects",
      "describe",
      projectId,
      `--account=${email}`,
      "--format=value(projectNumber)",
      "--quiet",
    ];
    let result = await this.commandRunner(args);
    if (result.exitCode !== 0 && isGcloudAuthenticationFailure(commandDetail(result))) {
      this.writeStatus("The saved Google Cloud login has expired. Reauthenticating...");
      await this.loginGcloudAccount(email);
      result = await this.commandRunner(args);
    }
    if (result.exitCode === 0) {
      const projectNumber = result.stdout.trim();
      return /^\d+$/u.test(projectNumber)
        ? { kind: "found", projectNumber }
        : { kind: "error", detail: "gcloud returned no project number." };
    }
    const detail = commandDetail(result);
    return isMissingProject(detail) || /permission.denied/iu.test(detail)
      ? { kind: "missing" }
      : { kind: "error", detail };
  }

  private async enableGmailApi(email: string, projectId: string): Promise<void> {
    this.writeStatus("Enabling the Gmail API...");
    const result = await this.commandRunner([
      "services",
      "enable",
      "gmail.googleapis.com",
      `--project=${projectId}`,
      `--account=${email}`,
      "--quiet",
    ]);
    if (result.exitCode !== 0) {
      throw this.gcloudFailure("enable the Gmail API", commandDetail(result));
    }
  }

  private async tryConfigureBrand(email: string, projectId: string): Promise<boolean> {
    try {
      const token = await this.commandRunner([
        "auth",
        "print-access-token",
        `--account=${email}`,
        "--quiet",
      ]);
      if (token.exitCode !== 0 || token.stdout.trim().length === 0) return false;
      const url = `https://oauth2.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/brands`;
      const existing = await this.fetch(url, {
        headers: { authorization: `Bearer ${token.stdout.trim()}` },
      });
      if (existing.ok) {
        const payload = (await existing.json().catch(() => undefined)) as unknown;
        if (isObject(payload) && Array.isArray(payload.brands) && payload.brands.length > 0) {
          return true;
        }
      }
      const created = await this.fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token.stdout.trim()}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ applicationTitle: "Invoice Fetcher", supportEmail: email }),
      });
      if (created.ok) return true;
      const body = await created.text().catch(() => "");
      return /already.exists/iu.test(body);
    } catch {
      return false;
    }
  }

  private async guideConsoleSetup(
    email: string,
    projectId: string,
    brandConfigured: boolean,
    internalAudience: boolean,
  ): Promise<void> {
    const separator = "─".repeat(56);
    if (!brandConfigured) {
      await this.openSetupPage(this.consoleSetupUrl("overview", projectId, email));
      this.writeStatus(
        [
          "",
          "A browser window has opened for Google Auth Platform setup.",
          "",
          "ACTION REQUIRED",
          "Complete all four steps below in the browser before returning to this terminal.",
          "",
          separator,
          "",
          `Before starting, confirm the account in the top-right corner is ${email}.`,
          "Click “Get Started”.",
          "",
          "1. App information",
          "   App name: Invoice Fetcher",
          `   User support email: ${email}`,
          "   Click “Next”.",
          "",
          "2. Audience",
          `   Select “${internalAudience ? "Internal" : "External"}”.`,
          "   Click “Next”.",
          "",
          "3. Contact information",
          `   Enter: ${email}`,
          "   Click “Next”.",
          "",
          "4. User data policy",
          "   Select “I agree to the Google API services user data policy”.",
          "   Click “Continue”.",
          "   Click “Create”.",
          "",
          separator,
          "Do not continue until all four browser steps are complete.",
        ].join("\n"),
      );
      await this.prompt.input("When finished, return to this terminal and press Enter");
    }
    if (!internalAudience) {
      await this.openSetupPage(this.consoleSetupUrl("audience", projectId, email));
      await this.prompt.input(
        "Publish the External app to In production for durable access, then press Enter",
      );
    }
    await this.openSetupPage(this.consoleSetupUrl("scopes", projectId, email));
    this.writeStatus(
      [
        "",
        "ACTION REQUIRED",
        "Configure Gmail access in the browser.",
        "",
        separator,
        "",
        "1. Click “Add or Remove Scopes”.",
        `2. Click “Enter property name or value” and enter “${GOOGLE_MAIL_SCOPE}”`,
        "3. Select the Gmail API item.",
        "4. Click “Update” at the bottom of the side panel.",
        "5. Click “Save” at the bottom of the main page.",
        "",
        separator,
      ].join("\n"),
    );
    await this.prompt.input("When the Gmail scope is saved, return here and press Enter");
    await this.openSetupPage(this.consoleSetupUrl("clients", projectId, email));
    this.writeStatus(
      [
        "",
        "ACTION REQUIRED",
        "Create the Desktop OAuth client in the browser.",
        "",
        separator,
        "",
        "1. Click “Create Client”.",
        "2. Under Application type, select “Desktop app”.",
        "3. Enter the name: Invoice Fetcher",
        "4. Click “Create”.",
        "5. Keep the resulting client ID and client secret available for the next prompts.",
        "",
        separator,
      ].join("\n"),
    );
    await this.prompt.input("When the Desktop client is created, return here and press Enter");
  }

  private consoleSetupUrl(section: string, projectId: string, email: string): string {
    const url = new URL(`https://console.cloud.google.com/auth/${section}`);
    url.searchParams.set("project", projectId);
    url.searchParams.set("authuser", email);
    return url.toString();
  }

  private async hasOrganizationParent(email: string, projectId: string): Promise<boolean> {
    const result = await this.commandRunner([
      "projects",
      "describe",
      projectId,
      `--account=${email}`,
      "--format=value(parent.type)",
      "--quiet",
    ]);
    return result.exitCode === 0 && result.stdout.trim() === "organization";
  }

  private async openSetupPage(url: string): Promise<void> {
    try {
      await this.browserOpener(url);
    } catch (error) {
      throw new GoogleCloudSetupError(`Could not open Google Cloud Console. Open this URL manually: ${url}`, {
        cause: error,
      });
    }
  }

  private async readClientCredentials(projectNumber: string): Promise<GoogleOAuthClient> {
    let clientId = "";
    while (clientId.length === 0) {
      const candidate = (await this.prompt.input("OAuth client ID")).trim();
      if (candidate.length === 0) throw new GoogleCloudSetupError("Google OAuth setup cancelled.");
      if (
        candidate.endsWith(".apps.googleusercontent.com") &&
        candidate.startsWith(`${projectNumber}-`)
      ) {
        clientId = candidate;
      } else {
        this.writeStatus("That OAuth client ID does not belong to the created project. Try again.");
      }
    }
    const clientSecret = (await this.prompt.secret("OAuth client secret")).trim();
    if (clientSecret.length === 0) throw new GoogleCloudSetupError("Google OAuth setup cancelled.");
    return {
      clientId,
      clientSecret,
      authorizationEndpoint: AUTHORIZATION_ENDPOINT,
      tokenEndpoint: TOKEN_ENDPOINT,
    };
  }

  private gcloudFailure(action: string, detail: string): GoogleCloudSetupError {
    if (/terms.of.service|precondition.check.failed/iu.test(detail)) {
      return new GoogleCloudSetupError(
        `Could not ${action} because Google Cloud Terms have not been accepted. Accept them at ${CLOUD_TERMS_URL}, then rerun the command.`,
      );
    }
    if (/quota|project.creation.*limit|limit.*project/iu.test(detail)) {
      return new GoogleCloudSetupError(
        `Could not ${action} because the Google account has reached a Cloud project quota or limit.`,
      );
    }
    if (/organization.policy|permission.denied|does.not.have.permission/iu.test(detail)) {
      return new GoogleCloudSetupError(
        `Could not ${action} because Google Cloud permissions or organization policy denied it.`,
      );
    }
    return new GoogleCloudSetupError(
      `Could not ${action}${detail.length === 0 ? "." : `: ${firstLine(detail)}`}`,
    );
  }
}

function commandDetail(result: GcloudCommandResult): string {
  return result.stderr.trim() || result.stdout.trim();
}

function firstLine(value: string): string {
  return value.split(/\r?\n/u)[0]?.trim() ?? "";
}

function isMissingProject(value: string): boolean {
  return /not.found|could.not.be.found|does.not.exist|may.not.exist/iu.test(value);
}

function isProjectIdUnavailable(value: string): boolean {
  return /already.in.use|already.exists|project.id.*in.use/iu.test(value);
}

function isGcloudAuthenticationFailure(value: string): boolean {
  return /invalid.grant|refreshing.*auth.*token|reauthentication|credentials?.*(?:expired|revoked)/iu.test(
    value,
  );
}

function isProjectId(value: string): boolean {
  return /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u.test(value);
}

function isErrorCode(value: unknown, code: string): boolean {
  return isObject(value) && value.code === code;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
