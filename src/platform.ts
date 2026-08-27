import os from "node:os";
import path from "node:path";

export type SupportedPlatform = "darwin" | "linux" | "win32";

export interface PlatformPathOptions {
  readonly platform?: NodeJS.Platform | undefined;
  readonly homeDirectory?: string | undefined;
  readonly environment?: NodeJS.ProcessEnv | undefined;
}

const SUPPORTED_PLATFORMS: readonly SupportedPlatform[] = ["darwin", "linux", "win32"];

export function isSupportedPlatform(platform: NodeJS.Platform): platform is SupportedPlatform {
  return (SUPPORTED_PLATFORMS as readonly NodeJS.Platform[]).includes(platform);
}

export function requireSupportedPlatform(platform: NodeJS.Platform): SupportedPlatform {
  if (!isSupportedPlatform(platform)) {
    throw new Error(
      `Unsupported operating system "${platform}". invoice-fetcher supports macOS, Linux, and Windows.`,
    );
  }
  return platform;
}

export function defaultApplicationConfigDirectory(options: PlatformPathOptions = {}): string {
  const platform = requireSupportedPlatform(options.platform ?? process.platform);
  const pathApi = pathForPlatform(platform);
  const homeDirectory = options.homeDirectory ?? os.homedir();
  const environment = options.environment ?? process.env;

  switch (platform) {
    case "darwin":
      return pathApi.join(homeDirectory, "Library", "Application Support", "invoice-fetcher");
    case "linux":
      return pathApi.join(
        absoluteEnvironmentPath(environment.XDG_CONFIG_HOME, pathApi) ??
          pathApi.join(homeDirectory, ".config"),
        "invoice-fetcher",
      );
    case "win32":
      return pathApi.join(
        absoluteEnvironmentPath(environment.APPDATA, pathApi) ??
          pathApi.join(homeDirectory, "AppData", "Roaming"),
        "invoice-fetcher",
      );
  }
}

export function defaultApplicationCacheDirectory(options: PlatformPathOptions = {}): string {
  const platform = requireSupportedPlatform(options.platform ?? process.platform);
  const pathApi = pathForPlatform(platform);
  const homeDirectory = options.homeDirectory ?? os.homedir();
  const environment = options.environment ?? process.env;

  switch (platform) {
    case "darwin":
      // Keep the existing managed-tool location so upgrades reuse prior downloads.
      return defaultApplicationConfigDirectory({ platform, homeDirectory, environment });
    case "linux":
      return pathApi.join(
        absoluteEnvironmentPath(environment.XDG_CACHE_HOME, pathApi) ??
          pathApi.join(homeDirectory, ".cache"),
        "invoice-fetcher",
      );
    case "win32":
      return pathApi.join(
        absoluteEnvironmentPath(environment.LOCALAPPDATA, pathApi) ??
          pathApi.join(homeDirectory, "AppData", "Local"),
        "invoice-fetcher",
      );
  }
}

export function pathForPlatform(platform: SupportedPlatform): typeof path.posix {
  return platform === "win32" ? path.win32 : path.posix;
}

function absoluteEnvironmentPath(
  value: string | undefined,
  pathApi: typeof path.posix,
): string | undefined {
  const candidate = environmentPath(value);
  return candidate !== undefined && pathApi.isAbsolute(candidate) ? candidate : undefined;
}

function environmentPath(value: string | undefined): string | undefined {
  const candidate = value?.trim();
  return candidate === undefined || candidate.length === 0 ? undefined : candidate;
}
