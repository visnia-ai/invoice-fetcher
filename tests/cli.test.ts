import assert from "node:assert/strict";
import test from "node:test";

import { main, type CliDependencies } from "../src/cli.js";

function dependencies(exitCode: 0 | 2 = 0): { dependencies: CliDependencies; output: string[] } {
  const output: string[] = [];
  return {
    output,
    dependencies: {
      runApplication: async () => ({
        exitCode,
        scanned: 0,
        copied: 0,
        deduplicated: 0,
        rejected: 0,
        failed: exitCode === 2 ? 1 : 0,
      }),
      runAccountCommand: async () => ({ lines: ["account result"] }),
      stdout: { write: (chunk) => output.push(String(chunk)) },
      stderr: { write: (chunk) => output.push(String(chunk)) },
      version: "9.8.7",
      platform: "darwin",
    },
  };
}

test("CLI returns the application's partial-failure status", async () => {
  const fixture = dependencies(2);
  const exitCode = await main(
    ["2026-01-01", "2026-01-31", "me@example.com", "/tmp/invoices"],
    fixture.dependencies,
  );
  assert.equal(exitCode, 2);
});

test("CLI prints help and version without running the application", async () => {
  const fixture = dependencies();
  fixture.dependencies.platform = "aix";
  let calls = 0;
  fixture.dependencies.runApplication = async () => {
    calls += 1;
    throw new Error("should not run");
  };

  assert.equal(await main(["--help"], fixture.dependencies), 0);
  assert.equal(await main(["--version"], fixture.dependencies), 0);
  assert.equal(calls, 0);
  assert.match(fixture.output.join(""), /invoice-fetcher <start-date> <end-date>/u);
  assert.match(fixture.output.join(""), /9\.8\.7/u);
});

test("CLI dispatches account commands without running an invoice search", async () => {
  const fixture = dependencies();
  let searches = 0;
  fixture.dependencies.runApplication = async () => {
    searches += 1;
    throw new Error("should not search");
  };

  assert.equal(await main(["list"], fixture.dependencies), 0);
  assert.equal(searches, 0);
  assert.match(fixture.output.join(""), /account result/u);
});

test("CLI dispatches account commands on Linux and Windows", async () => {
  for (const platform of ["linux", "win32"] as const) {
    const fixture = dependencies();
    fixture.dependencies.platform = platform;
    assert.equal(await main(["list"], fixture.dependencies), 0);
    assert.match(fixture.output.join(""), /account result/u);
  }
});

test("CLI rejects account commands on unsupported operating systems", async () => {
  const fixture = dependencies();
  fixture.dependencies.platform = "aix";
  assert.equal(await main(["list"], fixture.dependencies), 1);
  assert.match(fixture.output.join(""), /Unsupported operating system/u);
});

test("CLI turns fatal application failures into exit code 1", async () => {
  const fixture = dependencies();
  fixture.dependencies.runApplication = async () => {
    throw new Error("Mail permission denied");
  };

  const exitCode = await main(
    ["2026-01-01", "2026-01-31", "me@example.com", "/tmp/invoices"],
    fixture.dependencies,
  );
  assert.equal(exitCode, 1);
  assert.match(fixture.output.join(""), /Mail permission denied/u);
});
