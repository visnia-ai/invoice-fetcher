import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  open,
  rename,
  rm,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  defaultApplicationCacheDirectory,
  pathForPlatform,
  requireSupportedPlatform,
  type SupportedPlatform,
} from "../platform.js";

export const MANAGED_GCLOUD_VERSION = "582.0.0";

export interface GcloudCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface GcloudCommandOptions {
  readonly inheritStdio?: boolean;
  readonly windowsVerbatimArguments?: boolean;
}

export type GcloudCommandRunner = (
  args: readonly string[],
  options?: GcloudCommandOptions,
) => Promise<GcloudCommandResult>;

export type ExecutableCommandRunner = (
  executable: string,
  args: readonly string[],
  options?: GcloudCommandOptions,
) => Promise<GcloudCommandResult>;

export interface GcloudArchive {
  readonly url: string;
  readonly sha256: string;
  readonly format?: "tar.gz" | "zip";
}

export type GcloudArchiveTarget =
  | "darwin-arm64"
  | "darwin-x64"
  | "linux-arm64"
  | "linux-x64"
  | "win32-x64";

export interface GcloudCliResolverDependencies {
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly toolsDirectory?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly executableRunner?: ExecutableCommandRunner;
  readonly writeStatus?: (message: string) => void;
  readonly archives?: Readonly<Partial<Record<GcloudArchiveTarget, GcloudArchive>>>;
  readonly tarPath?: string;
  readonly commandShell?: string;
}

const ARCHIVES: Readonly<Record<GcloudArchiveTarget, GcloudArchive>> = {
  "darwin-arm64": {
    url: `https://storage.googleapis.com/cloud-sdk-release/google-cloud-cli-${MANAGED_GCLOUD_VERSION}-darwin-arm.tar.gz`,
    sha256: "818977c5ab1af6664e9f0bfcea38a8e4cddf7dfab5776c45b8d2ff1d3cf79ab3",
    format: "tar.gz",
  },
  "darwin-x64": {
    url: `https://storage.googleapis.com/cloud-sdk-release/google-cloud-cli-${MANAGED_GCLOUD_VERSION}-darwin-x86_64.tar.gz`,
    sha256: "c35c42a7f027c4d356e9007ea408855259b84d9871b2cdcc93c6d729e8173a09",
    format: "tar.gz",
  },
  "linux-arm64": {
    url: `https://storage.googleapis.com/cloud-sdk-release/google-cloud-cli-${MANAGED_GCLOUD_VERSION}-linux-arm.tar.gz`,
    sha256: "aa3d9e61f12c6cf715c2f87d331cf42b175ce4a6cc1b0a4c69de032691f26c00",
    format: "tar.gz",
  },
  "linux-x64": {
    url: `https://storage.googleapis.com/cloud-sdk-release/google-cloud-cli-${MANAGED_GCLOUD_VERSION}-linux-x86_64.tar.gz`,
    sha256: "e917ca3a21bc9d5ae13759d11a581a6a948a5170f257f2640a25e7c44cf6a8a5",
    format: "tar.gz",
  },
  "win32-x64": {
    url: `https://storage.googleapis.com/cloud-sdk-release/google-cloud-cli-${MANAGED_GCLOUD_VERSION}-windows-x86_64.zip`,
    sha256: "72fe577f151ae33d7ff480a5bea516be7316bbcf08205733755bce2468e99577",
    format: "zip",
  },
};

export class GcloudCliError extends Error {
  override readonly name = "GcloudCliError";
}

export function defaultGcloudToolsDirectory(
  homeDirectory = os.homedir(),
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const supportedPlatform = requireSupportedPlatform(platform);
  return pathForPlatform(supportedPlatform).join(
    defaultApplicationCacheDirectory({ platform: supportedPlatform, homeDirectory, environment }),
    "tools",
  );
}

export const runExecutableCommand: ExecutableCommandRunner = (
  executable,
  args,
  options = {},
) =>
  new Promise((resolve, reject) => {
    const inherit = options.inheritStdio === true;
    const child = spawn(executable, args, {
      shell: false,
      windowsVerbatimArguments: options.windowsVerbatimArguments === true,
      stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        CLOUDSDK_SURVEY_DISABLE_PROMPTS: "true",
      },
    });
    let stdout = "";
    let stderr = "";
    if (!inherit) {
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });
    }
    child.once("error", reject);
    child.once("close", (exitCode) => {
      resolve({ exitCode: exitCode ?? 1, stdout, stderr });
    });
  });

export class GcloudCliResolver {
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;
  private readonly toolsDirectory: string | undefined;
  private readonly fetch: typeof globalThis.fetch;
  private readonly executableRunner: ExecutableCommandRunner;
  private readonly writeStatus: (message: string) => void;
  private readonly archives: Readonly<Partial<Record<GcloudArchiveTarget, GcloudArchive>>>;
  private readonly tarPath: string;
  private readonly commandShell: string;
  private resolution: Promise<string> | undefined;

  constructor(dependencies: GcloudCliResolverDependencies = {}) {
    this.platform = dependencies.platform ?? process.platform;
    this.arch = dependencies.arch ?? process.arch;
    this.toolsDirectory = dependencies.toolsDirectory;
    this.fetch = dependencies.fetch ?? globalThis.fetch;
    this.executableRunner = dependencies.executableRunner ?? runExecutableCommand;
    this.writeStatus = dependencies.writeStatus ?? ((message) => process.stderr.write(`${message}\n`));
    this.archives = dependencies.archives ?? ARCHIVES;
    this.tarPath = dependencies.tarPath ?? (this.platform === "win32" ? "tar.exe" : "/usr/bin/tar");
    this.commandShell = dependencies.commandShell ?? process.env.ComSpec ?? "cmd.exe";
  }

  resolve(): Promise<string> {
    this.resolution ??= this.resolveOnce();
    return this.resolution;
  }

  async run(
    args: readonly string[],
    options: GcloudCommandOptions = {},
    executableRunner: ExecutableCommandRunner = this.executableRunner,
  ): Promise<GcloudCommandResult> {
    const executable = await this.resolve();
    return await this.execute(executable, args, options, executableRunner);
  }

  private async resolveOnce(): Promise<string> {
    if (await this.canRun("gcloud")) return "gcloud";
    if (this.platform === "win32" && this.arch === "arm64") {
      throw new GcloudCliError(
        "Automatic Google setup cannot download a native Google Cloud CLI archive for Windows ARM64. Install gcloud yourself and retry.",
      );
    }
    if (!isManagedGcloudPlatform(this.platform)) {
      throw new GcloudCliError(
        `Automatic Google setup does not support the ${this.platform} operating system. Install gcloud yourself and retry.`,
      );
    }
    const target = managedGcloudTarget(this.platform, this.arch);
    const archive = this.archives[target];
    if (archive === undefined) {
      throw new GcloudCliError(
        `Automatic Google setup has no archive configured for ${this.platform} ${this.arch}. Install gcloud yourself and retry.`,
      );
    }

    const toolsDirectory =
      this.toolsDirectory ?? defaultGcloudToolsDirectory(os.homedir(), this.platform);
    await mkdir(toolsDirectory, { recursive: true, mode: 0o700 });
    const destination = path.join(
      toolsDirectory,
      `google-cloud-sdk-${MANAGED_GCLOUD_VERSION}`,
    );
    const cachedExecutable = this.gcloudExecutable(destination);
    if (await this.isExecutable(cachedExecutable)) {
      if (await this.canRun(cachedExecutable)) return cachedExecutable;
      await rm(destination, { recursive: true, force: true });
    }

    return await this.installManagedGcloud(toolsDirectory, destination, archive);
  }

  private async installManagedGcloud(
    toolsDirectory: string,
    destination: string,
    archive: GcloudArchive,
  ): Promise<string> {
    this.writeStatus(
      `Downloading Google Cloud CLI ${MANAGED_GCLOUD_VERSION} for automatic setup (up to about 87 MB)...`,
    );
    const workDirectory = await mkdtemp(
      path.join(toolsDirectory, `.gcloud-${MANAGED_GCLOUD_VERSION}-`),
    );
    await chmod(workDirectory, 0o700);
    const archiveFormat = archive.format ?? (archive.url.endsWith(".zip") ? "zip" : "tar.gz");
    const archivePath = path.join(
      workDirectory,
      archiveFormat === "zip" ? "google-cloud-cli.zip" : "google-cloud-cli.tar.gz",
    );
    try {
      const actualChecksum = await this.download(archive.url, archivePath);
      if (actualChecksum !== archive.sha256.toLowerCase()) {
        throw new GcloudCliError(
          "The downloaded Google Cloud CLI failed checksum verification. Nothing was installed; retry later.",
        );
      }

      this.writeStatus("Installing the verified Google Cloud CLI...");
      let extracted: GcloudCommandResult;
      try {
        extracted = await this.executableRunner(this.tarPath, [
          archiveFormat === "zip" ? "-xf" : "-xzf",
          archivePath,
          "-C",
          workDirectory,
        ]);
      } catch (error) {
        throw new GcloudCliError(
          "Could not extract the downloaded Google Cloud CLI. Nothing was installed.",
          { cause: error },
        );
      }
      if (extracted.exitCode !== 0) {
        throw new GcloudCliError(
          `Could not extract the downloaded Google Cloud CLI${detailSuffix(extracted)}. Nothing was installed.`,
        );
      }

      const extractedRoot = path.join(workDirectory, "google-cloud-sdk");
      const extractedExecutable = this.gcloudExecutable(extractedRoot);
      if (!(await this.isExecutable(extractedExecutable))) {
        throw new GcloudCliError(
          "The downloaded Google Cloud CLI archive did not contain an executable gcloud command. Nothing was installed.",
        );
      }
      const validation = await this.tryRun(extractedExecutable);
      if (validation === undefined || validation.exitCode !== 0) {
        throw this.unusableManagedGcloud(validation);
      }

      try {
        await rename(extractedRoot, destination);
      } catch (error) {
        if (
          !(
            isErrorCode(error, "EEXIST") ||
            isErrorCode(error, "ENOTEMPTY") ||
            isErrorCode(error, "EACCES") ||
            isErrorCode(error, "EPERM")
          )
        ) {
          throw error;
        }
        const winningExecutable = this.gcloudExecutable(destination);
        if (!(await this.isExecutable(winningExecutable)) || !(await this.canRun(winningExecutable))) {
          throw new GcloudCliError(
            "Another Google Cloud CLI installation did not complete successfully. Retry the command.",
            { cause: error },
          );
        }
        return winningExecutable;
      }
      return this.gcloudExecutable(destination);
    } catch (error) {
      if (error instanceof GcloudCliError) throw error;
      throw new GcloudCliError(
        "Could not install the Google Cloud CLI for automatic setup. Retry later.",
        { cause: error },
      );
    } finally {
      await rm(workDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async download(url: string, destination: string): Promise<string> {
    let response: Response;
    try {
      response = await this.fetch(url);
    } catch (error) {
      throw new GcloudCliError(
        "Could not download the Google Cloud CLI. Check the network connection and retry.",
        { cause: error },
      );
    }
    if (!response.ok || response.body === null) {
      throw new GcloudCliError(
        `Could not download the Google Cloud CLI (HTTP ${response.status}). Retry later.`,
      );
    }

    const hash = createHash("sha256");
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(destination, "wx", 0o600);
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(value);
        await handle.writeFile(value);
      }
      await handle.sync();
      await handle.close();
      handle = undefined;
      return hash.digest("hex");
    } catch (error) {
      if (error instanceof GcloudCliError) throw error;
      throw new GcloudCliError(
        "The Google Cloud CLI download was interrupted. Nothing was installed; retry the command.",
        { cause: error },
      );
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async canRun(executable: string): Promise<boolean> {
    const result = await this.tryRun(executable);
    return result?.exitCode === 0;
  }

  private async tryRun(executable: string): Promise<GcloudCommandResult | undefined> {
    try {
      return await this.execute(
        executable,
        ["version", "--format=json"],
        {},
        this.executableRunner,
      );
    } catch {
      return undefined;
    }
  }

  private gcloudExecutable(sdkRoot: string): string {
    return path.join(sdkRoot, "bin", this.platform === "win32" ? "gcloud.cmd" : "gcloud");
  }

  private async execute(
    executable: string,
    args: readonly string[],
    options: GcloudCommandOptions,
    runner: ExecutableCommandRunner,
  ): Promise<GcloudCommandResult> {
    if (this.platform !== "win32" || (executable !== "gcloud" && !/\.(?:cmd|bat)$/iu.test(executable))) {
      return await runner(executable, args, options);
    }
    return await runner(
      this.commandShell,
      windowsCommandArguments(executable, args),
      { ...options, windowsVerbatimArguments: true },
    );
  }

  private async isExecutable(filePath: string): Promise<boolean> {
    try {
      await access(filePath, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  private unusableManagedGcloud(result: GcloudCommandResult | undefined): GcloudCliError {
    const detail = result === undefined ? "" : `${result.stderr}\n${result.stdout}`;
    if (/python|cloudsdk_python/iu.test(detail)) {
      return new GcloudCliError(
        "The Google Cloud CLI requires Python 3.10–3.14. Install a supported Python version, then retry.",
      );
    }
    return new GcloudCliError(
      `The downloaded Google Cloud CLI could not run${result === undefined ? "" : detailSuffix(result)}. Install gcloud yourself or retry.`,
    );
  }
}

export function createGcloudCommandRunner(
  resolver = new GcloudCliResolver(),
  executableRunner?: ExecutableCommandRunner,
): GcloudCommandRunner {
  return async (args, options) =>
    await resolver.run(args, options ?? {}, executableRunner);
}

export const runGcloudCommand: GcloudCommandRunner = createGcloudCommandRunner();

function detailSuffix(result: GcloudCommandResult): string {
  const detail = (result.stderr.trim() || result.stdout.trim()).split(/\r?\n/u)[0]?.trim() ?? "";
  return detail.length === 0 ? "" : `: ${detail}`;
}

function isErrorCode(value: unknown, code: string): boolean {
  return typeof value === "object" && value !== null && "code" in value && value.code === code;
}

function isManagedGcloudPlatform(platform: NodeJS.Platform): platform is SupportedPlatform {
  return platform === "darwin" || platform === "linux" || platform === "win32";
}

function managedGcloudTarget(
  platform: SupportedPlatform,
  arch: string,
): GcloudArchiveTarget {
  if (arch !== "arm64" && arch !== "x64") {
    throw new GcloudCliError(
      `Automatic Google setup does not support the ${arch} architecture on ${platform}. Install gcloud yourself and retry.`,
    );
  }
  if (platform === "win32" && arch === "arm64") {
    throw new GcloudCliError(
      "Automatic Google setup cannot download a native Google Cloud CLI archive for Windows ARM64. Install gcloud yourself and retry.",
    );
  }
  if (platform === "darwin") return arch === "arm64" ? "darwin-arm64" : "darwin-x64";
  if (platform === "linux") return arch === "arm64" ? "linux-arm64" : "linux-x64";
  return "win32-x64";
}

// Mirrors cross-spawn's proven cmd.exe escaping. Batch shims need two escaping
// passes because cmd.exe parses once and the .cmd file expands the arguments again.
const WINDOWS_CMD_META_CHARACTERS = /([()\][%!^"`<>&|;, *?])/gu;

function windowsCommandArguments(executable: string, args: readonly string[]): readonly string[] {
  const commandLine = [escapeWindowsCommand(executable), ...args.map(escapeWindowsArgument)].join(" ");
  return ["/d", "/s", "/v:off", "/c", `"${commandLine}"`];
}

function escapeWindowsCommand(command: string): string {
  return command.replace(WINDOWS_CMD_META_CHARACTERS, "^$1");
}

function escapeWindowsArgument(value: string): string {
  let escaped = value.replace(/(?=(\\+?)?)\1"/gu, "$1$1\\\"");
  escaped = escaped.replace(/(?=(\\+?)?)\1$/u, "$1$1");
  escaped = `"${escaped}"`;
  escaped = escaped.replace(WINDOWS_CMD_META_CHARACTERS, "^$1");
  return escaped.replace(WINDOWS_CMD_META_CHARACTERS, "^$1");
}
