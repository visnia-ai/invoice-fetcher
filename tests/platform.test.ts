import assert from "node:assert/strict";
import test from "node:test";

import { defaultProfilePath } from "../src/accounts/profile-store.js";
import { defaultGoogleCloudSetupStatePath } from "../src/auth/google-cloud-setup.js";
import { defaultBrowserOpenCommand } from "../src/auth/google-oauth.js";
import {
  defaultApplicationCacheDirectory,
  defaultApplicationConfigDirectory,
  requireSupportedPlatform,
} from "../src/platform.js";

test("platform config paths preserve macOS and follow Linux and Windows conventions", () => {
  assert.equal(
    defaultApplicationConfigDirectory({
      platform: "darwin",
      homeDirectory: "/Users/example",
      environment: {},
    }),
    "/Users/example/Library/Application Support/invoice-fetcher",
  );
  assert.equal(
    defaultApplicationConfigDirectory({
      platform: "linux",
      homeDirectory: "/home/example",
      environment: { XDG_CONFIG_HOME: "/var/config" },
    }),
    "/var/config/invoice-fetcher",
  );
  assert.equal(
    defaultApplicationConfigDirectory({
      platform: "linux",
      homeDirectory: "/home/example",
      environment: { XDG_CONFIG_HOME: "relative/config" },
    }),
    "/home/example/.config/invoice-fetcher",
  );
  assert.equal(
    defaultApplicationConfigDirectory({
      platform: "win32",
      homeDirectory: String.raw`C:\Users\example`,
      environment: { APPDATA: String.raw`D:\Roaming` },
    }),
    String.raw`D:\Roaming\invoice-fetcher`,
  );
  assert.equal(
    defaultApplicationConfigDirectory({
      platform: "win32",
      homeDirectory: String.raw`C:\Users\example`,
      environment: { APPDATA: "relative\\roaming" },
    }),
    String.raw`C:\Users\example\AppData\Roaming\invoice-fetcher`,
  );
});

test("platform cache paths use XDG and LocalAppData while preserving the macOS tool root", () => {
  assert.equal(
    defaultApplicationCacheDirectory({
      platform: "darwin",
      homeDirectory: "/Users/example",
      environment: {},
    }),
    "/Users/example/Library/Application Support/invoice-fetcher",
  );
  assert.equal(
    defaultApplicationCacheDirectory({
      platform: "linux",
      homeDirectory: "/home/example",
      environment: { XDG_CACHE_HOME: "/var/cache/user" },
    }),
    "/var/cache/user/invoice-fetcher",
  );
  assert.equal(
    defaultApplicationCacheDirectory({
      platform: "linux",
      homeDirectory: "/home/example",
      environment: {},
    }),
    "/home/example/.cache/invoice-fetcher",
  );
  assert.equal(
    defaultApplicationCacheDirectory({
      platform: "win32",
      homeDirectory: String.raw`C:\Users\example`,
      environment: { LOCALAPPDATA: String.raw`D:\Local` },
    }),
    String.raw`D:\Local\invoice-fetcher`,
  );
});

test("profile and Google setup files use the platform config root", () => {
  assert.equal(
    defaultProfilePath("/home/example", "linux", { XDG_CONFIG_HOME: "/config" }),
    "/config/invoice-fetcher/profiles.json",
  );
  assert.equal(
    defaultGoogleCloudSetupStatePath(
      String.raw`C:\Users\example`,
      "win32",
      { APPDATA: String.raw`D:\Roaming` },
    ),
    String.raw`D:\Roaming\invoice-fetcher\google-cloud-setup.json`,
  );
});

test("browser opening uses platform commands without a shell", () => {
  const url = "https://example.test/oauth?state=a&next=b";
  assert.deepEqual(defaultBrowserOpenCommand(url, "darwin"), {
    executable: "/usr/bin/open",
    args: [url],
  });
  assert.deepEqual(defaultBrowserOpenCommand(url, "linux"), {
    executable: "xdg-open",
    args: [url],
  });
  assert.deepEqual(defaultBrowserOpenCommand(url, "win32"), {
    executable: "rundll32.exe",
    args: ["url.dll,FileProtocolHandler", url],
  });
});

test("supported platform validation rejects other operating systems clearly", () => {
  assert.equal(requireSupportedPlatform("darwin"), "darwin");
  assert.equal(requireSupportedPlatform("linux"), "linux");
  assert.equal(requireSupportedPlatform("win32"), "win32");
  assert.throws(
    () => requireSupportedPlatform("aix"),
    /Unsupported operating system "aix".*macOS, Linux, and Windows/u,
  );
});
