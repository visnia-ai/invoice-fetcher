import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  GcloudCliError,
  GcloudCliResolver,
  MANAGED_GCLOUD_VERSION,
  createGcloudCommandRunner,
  defaultGcloudToolsDirectory,
  runExecutableCommand,
  type ExecutableCommandRunner,
  type GcloudArchive,
  type GcloudArchiveTarget,
  type GcloudCommandResult,
} from "../src/auth/index.js";

const TAR_PATH = process.platform === "win32" ? "tar.exe" : "/usr/bin/tar";

test("resolver prefers one working system gcloud probe", async () => {
  let downloads = 0;
  const calls: string[] = [];
  const resolver = new GcloudCliResolver({
    platform: "darwin",
    arch: "arm64",
    executableRunner: async (executable) => {
      calls.push(executable);
      return success();
    },
    fetch: async () => {
      downloads += 1;
      return new Response();
    },
    writeStatus: () => undefined,
  });

  assert.deepEqual(await Promise.all([resolver.resolve(), resolver.resolve()]), ["gcloud", "gcloud"]);
  assert.deepEqual(calls, ["gcloud"]);
  assert.equal(downloads, 0);
});

test("gcloud subprocesses disable survey prompts without changing saved configuration", async () => {
  const result = await runExecutableCommand(process.execPath, [
    "-e",
    "process.stdout.write(`CLOUDSDK_SURVEY_DISABLE_PROMPTS=${process.env.CLOUDSDK_SURVEY_DISABLE_PROMPTS ?? ''}`)",
  ]);

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /^CLOUDSDK_SURVEY_DISABLE_PROMPTS=true$/mu);
});

test("resolver selects and caches every supported platform archive", async () => {
  const targets = [
    ["darwin", "arm64", "darwin-arm64", "gcloud", "-xzf"],
    ["darwin", "x64", "darwin-x64", "gcloud", "-xzf"],
    ["linux", "arm64", "linux-arm64", "gcloud", "-xzf"],
    ["linux", "x64", "linux-x64", "gcloud", "-xzf"],
    ["win32", "x64", "win32-x64", "gcloud.cmd", "-xf"],
  ] as const;
  for (const [platform, architecture, target, executableName, extractionFlag] of targets) {
    const directory = await mkdtemp(path.join(os.tmpdir(), `invoice-fetcher-gcloud-${target}-`));
    const toolsDirectory = path.join(directory, "tools");
    const fixture = await createGcloudArchive(directory);
    const requested: string[] = [];
    const archives = archiveManifest(fixture.sha256, target);
    const extractionArgs: readonly string[][] = [];
    const runner = managedRunner(extractionArgs);
    const resolver = new GcloudCliResolver({
      platform,
      arch: architecture,
      toolsDirectory,
      archives,
      executableRunner: runner,
      fetch: async (url) => {
        requested.push(String(url));
        return new Response(fixture.data, { status: 200 });
      },
      writeStatus: () => undefined,
    });

    const executable = await resolver.resolve();

    assert.equal(
      executable,
      path.join(
        toolsDirectory,
        `google-cloud-sdk-${MANAGED_GCLOUD_VERSION}`,
        "bin",
        executableName,
      ),
    );
    assert.deepEqual(requested, [archives[target]?.url]);
    assert.equal(extractionArgs[0]?.[0], extractionFlag);
    assert.match(await readFile(executable, "utf8"), /fixture/u);

    const cached = new GcloudCliResolver({
      platform,
      arch: architecture,
      toolsDirectory,
      archives,
      executableRunner: runner,
      fetch: async () => {
        throw new Error("cache hit must not download");
      },
      writeStatus: () => undefined,
    });
    assert.equal(await cached.resolve(), executable);
  }
});

test("checksum mismatch leaves no partial managed installation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "invoice-fetcher-gcloud-checksum-"));
  const toolsDirectory = path.join(directory, "tools");
  const fixture = await createGcloudArchive(directory);
  const resolver = new GcloudCliResolver({
    platform: "darwin",
    arch: "arm64",
    toolsDirectory,
    archives: archiveManifest("0".repeat(64)),
    executableRunner: managedRunner(),
    fetch: async () => new Response(fixture.data, { status: 200 }),
    writeStatus: () => undefined,
  });

  await assert.rejects(
    resolver.resolve(),
    (error: unknown) => error instanceof GcloudCliError && /checksum/u.test(error.message),
  );
  assert.deepEqual(await readdir(toolsDirectory), []);
});

test("network and extraction failures are actionable and clean up temporary files", async () => {
  const networkDirectory = await mkdtemp(path.join(os.tmpdir(), "invoice-fetcher-gcloud-network-"));
  const networkTools = path.join(networkDirectory, "tools");
  const networkResolver = new GcloudCliResolver({
    platform: "darwin",
    arch: "arm64",
    toolsDirectory: networkTools,
    executableRunner: managedRunner(),
    fetch: async () => {
      throw new Error("offline");
    },
    writeStatus: () => undefined,
  });
  await assert.rejects(
    networkResolver.resolve(),
    (error: unknown) =>
      error instanceof GcloudCliError &&
      /network connection/u.test(error.message) &&
      !/gcloud CLI is required/u.test(error.message),
  );
  assert.deepEqual(await readdir(networkTools), []);

  const extractDirectory = await mkdtemp(path.join(os.tmpdir(), "invoice-fetcher-gcloud-extract-"));
  const extractTools = path.join(extractDirectory, "tools");
  const fixture = await createGcloudArchive(extractDirectory);
  const runner: ExecutableCommandRunner = async (executable) => {
    if (executable === "gcloud") throw missingExecutable();
    if (isTarExecutable(executable)) return failure("archive rejected");
    return success();
  };
  const extractResolver = new GcloudCliResolver({
    platform: "darwin",
    arch: "arm64",
    toolsDirectory: extractTools,
    archives: archiveManifest(fixture.sha256),
    executableRunner: runner,
    fetch: async () => new Response(fixture.data, { status: 200 }),
    writeStatus: () => undefined,
  });
  await assert.rejects(
    extractResolver.resolve(),
    (error: unknown) => error instanceof GcloudCliError && /extract/u.test(error.message),
  );
  assert.deepEqual(await readdir(extractTools), []);
});

test("an interrupted response stream leaves no partial managed installation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "invoice-fetcher-gcloud-interrupted-"));
  const toolsDirectory = path.join(directory, "tools");
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("partial archive"));
      controller.error(new Error("connection reset"));
    },
  });
  const resolver = new GcloudCliResolver({
    platform: "darwin",
    arch: "arm64",
    toolsDirectory,
    executableRunner: managedRunner(),
    fetch: async () => new Response(body, { status: 200 }),
    writeStatus: () => undefined,
  });

  await assert.rejects(
    resolver.resolve(),
    (error: unknown) => error instanceof GcloudCliError && /interrupted/u.test(error.message),
  );
  assert.deepEqual(await readdir(toolsDirectory), []);
});

test("unsupported architectures and operating systems fail before downloading", async () => {
  let downloaded = false;
  const resolver = new GcloudCliResolver({
    platform: "darwin",
    arch: "ia32",
    executableRunner: async () => {
      throw missingExecutable();
    },
    fetch: async () => {
      downloaded = true;
      return new Response();
    },
    writeStatus: () => undefined,
  });

  await assert.rejects(
    resolver.resolve(),
    (error: unknown) => error instanceof GcloudCliError && /architecture/u.test(error.message),
  );
  assert.equal(downloaded, false);

  for (const [platform, arch, message] of [
    ["win32", "arm64", /Windows ARM64/u],
    ["freebsd", "x64", /operating system/u],
  ] as const) {
    const unsupported = new GcloudCliResolver({
      platform,
      arch,
      executableRunner: async () => {
        throw missingExecutable();
      },
      fetch: async () => {
        downloaded = true;
        return new Response();
      },
      writeStatus: () => undefined,
    });
    await assert.rejects(
      unsupported.resolve(),
      (error: unknown) => error instanceof GcloudCliError && message.test(error.message),
    );
  }
  assert.equal(downloaded, false);
});

test("default managed-tool directory follows each platform cache convention", () => {
  assert.equal(
    defaultGcloudToolsDirectory("/Users/person", "darwin", {}),
    "/Users/person/Library/Application Support/invoice-fetcher/tools",
  );
  assert.equal(
    defaultGcloudToolsDirectory("/home/person", "linux", { XDG_CACHE_HOME: "/var/cache/person" }),
    "/var/cache/person/invoice-fetcher/tools",
  );
  assert.equal(
    defaultGcloudToolsDirectory("C:\\Users\\person", "win32", {
      LOCALAPPDATA: "D:\\Profile Cache",
    }),
    "D:\\Profile Cache\\invoice-fetcher\\tools",
  );
});

test("Windows system and managed command shims use safely escaped cmd.exe invocation", async () => {
  const calls: Array<{
    executable: string;
    args: readonly string[];
    options: Parameters<ExecutableCommandRunner>[2];
  }> = [];
  const runner: ExecutableCommandRunner = async (executable, args, options) => {
    calls.push({ executable, args, options });
    return success();
  };
  const resolver = new GcloudCliResolver({
    platform: "win32",
    arch: "x64",
    commandShell: "C:\\Windows\\System32\\cmd.exe",
    executableRunner: runner,
    writeStatus: () => undefined,
  });
  const command = createGcloudCommandRunner(resolver, runner);

  await command(["projects", "describe", "value%PATH%&whoami", "quote\"and space"]);

  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.executable, "C:\\Windows\\System32\\cmd.exe");
    assert.deepEqual(call.args.slice(0, 4), ["/d", "/s", "/v:off", "/c"]);
    assert.equal(call.options?.windowsVerbatimArguments, true);
  }
  const commandLine = calls[1]?.args[4] ?? "";
  assert.match(commandLine, /\^\^\^%PATH\^\^\^%\^\^\^&/u);
  assert.doesNotMatch(commandLine, /(?<!\^)%PATH/u);
});

test("concurrent managed installs atomically resolve to one complete cache", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "invoice-fetcher-gcloud-concurrent-"));
  const toolsDirectory = path.join(directory, "tools");
  const fixture = await createGcloudArchive(directory);
  const dependencies = {
    platform: "darwin" as const,
    arch: "arm64",
    toolsDirectory,
    archives: archiveManifest(fixture.sha256, "darwin-arm64"),
    executableRunner: managedRunner(),
    fetch: async () => new Response(fixture.data, { status: 200 }),
    writeStatus: () => undefined,
  };
  const first = new GcloudCliResolver(dependencies);
  const second = new GcloudCliResolver(dependencies);

  const resolved = await Promise.all([first.resolve(), second.resolve()]);

  assert.equal(resolved[0], resolved[1]);
  assert.match(await readFile(resolved[0], "utf8"), /fixture/u);
  assert.deepEqual(await readdir(toolsDirectory), [`google-cloud-sdk-${MANAGED_GCLOUD_VERSION}`]);
});

test("missing Python is reported without caching an unusable SDK", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "invoice-fetcher-gcloud-python-"));
  const toolsDirectory = path.join(directory, "tools");
  const fixture = await createGcloudArchive(directory);
  const runner: ExecutableCommandRunner = async (executable, args, options) => {
    if (executable === "gcloud") throw missingExecutable();
    if (isTarExecutable(executable)) return await runExecutableCommand(TAR_PATH, args, options);
    return failure("Python executable was not found; set CLOUDSDK_PYTHON");
  };
  const resolver = new GcloudCliResolver({
    platform: "darwin",
    arch: "arm64",
    toolsDirectory,
    archives: archiveManifest(fixture.sha256),
    executableRunner: runner,
    fetch: async () => new Response(fixture.data, { status: 200 }),
    writeStatus: () => undefined,
  });

  await assert.rejects(
    resolver.resolve(),
    (error: unknown) => error instanceof GcloudCliError && /Python 3\.10–3\.14/u.test(error.message),
  );
  assert.deepEqual(await readdir(toolsDirectory), []);
});

async function createGcloudArchive(
  directory: string,
): Promise<{ data: Buffer; sha256: string }> {
  const source = path.join(directory, `source-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const executable = path.join(source, "google-cloud-sdk", "bin", "gcloud");
  const windowsExecutable = path.join(source, "google-cloud-sdk", "bin", "gcloud.cmd");
  await mkdir(path.dirname(executable), { recursive: true });
  await writeFile(executable, "#!/bin/sh\n# fixture\nexit 0\n", { mode: 0o755 });
  await writeFile(windowsExecutable, "@rem fixture\r\n@exit /b 0\r\n", { mode: 0o755 });
  await chmod(executable, 0o755);
  await chmod(windowsExecutable, 0o755);
  const archivePath = path.join(directory, `fixture-${Date.now()}-${Math.random().toString(16).slice(2)}.tar.gz`);
  const result = await runExecutableCommand(TAR_PATH, [
    "-czf",
    archivePath,
    "-C",
    source,
    "google-cloud-sdk",
  ]);
  assert.equal(result.exitCode, 0, result.stderr);
  const data = await readFile(archivePath);
  return { data, sha256: createHash("sha256").update(data).digest("hex") };
}

function archiveManifest(
  sha256: string,
  target: GcloudArchiveTarget = "darwin-arm64",
): Readonly<Partial<Record<GcloudArchiveTarget, GcloudArchive>>> {
  const windows = target === "win32-x64";
  return {
    [target]: {
      url: windows
        ? "https://example.test/google-cloud-cli-windows-x86_64.zip"
        : `https://example.test/google-cloud-cli-${target}.tar.gz`,
      sha256,
      format: windows ? "zip" : "tar.gz",
    },
  };
}

function managedRunner(extractionArgs?: Array<readonly string[]>): ExecutableCommandRunner {
  return async (executable, args, options) => {
    if (executable === "gcloud") throw missingExecutable();
    if (executable === "cmd.exe") {
      if ((args[4] ?? "").startsWith('"gcloud ')) throw missingExecutable();
      return success();
    }
    if (isTarExecutable(executable)) {
      extractionArgs?.push(args);
      return await runExecutableCommand(TAR_PATH, args, options);
    }
    return success();
  };
}

function isTarExecutable(executable: string): boolean {
  return executable === "/usr/bin/tar" || executable === "tar.exe";
}

function missingExecutable(): Error & { code: string } {
  return Object.assign(new Error("spawn gcloud ENOENT"), { code: "ENOENT" });
}

function success(stdout = ""): GcloudCommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function failure(stderr: string): GcloudCommandResult {
  return { exitCode: 1, stdout: "", stderr };
}
