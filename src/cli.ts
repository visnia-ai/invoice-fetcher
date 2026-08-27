#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import type { AccountCommand, AccountCommandResult } from "./accounts/index.js";
import { CliUsageError, parseCommandLine, USAGE } from "./arguments.js";
import { runApplication } from "./app.js";
import { requireSupportedPlatform } from "./platform.js";
import { getDefaultRuntimeServices } from "./runtime.js";
import type { CliOptions, ExitCode, RunSummary } from "./types.js";

export interface CliDependencies {
  runApplication: (options: CliOptions) => Promise<RunSummary>;
  runAccountCommand: (command: AccountCommand) => Promise<AccountCommandResult>;
  stdout: Pick<NodeJS.WriteStream, "write">;
  stderr: Pick<NodeJS.WriteStream, "write">;
  version: string;
  platform: NodeJS.Platform;
}

const runtime = getDefaultRuntimeServices();
const defaultDependencies: CliDependencies = {
  runApplication,
  runAccountCommand: (command) => runtime.accountCommands.execute(command),
  stdout: process.stdout,
  stderr: process.stderr,
  version: "1.0.0",
  platform: process.platform,
};

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  dependencies: CliDependencies = defaultDependencies,
): Promise<ExitCode> {
  try {
    const command = parseCommandLine(argv);
    if (command.kind === "help") {
      dependencies.stdout.write(`${USAGE}\n`);
      return 0;
    }
    if (command.kind === "version") {
      dependencies.stdout.write(`${dependencies.version}\n`);
      return 0;
    }
    requireSupportedPlatform(dependencies.platform);
    if (command.kind === "account") {
      const result = await dependencies.runAccountCommand(command.command);
      for (const line of result.lines) dependencies.stdout.write(`${line}\n`);
      return 0;
    }

    const summary = await dependencies.runApplication(command.options);
    return summary.exitCode;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    dependencies.stderr.write(`invoice-fetcher: ${message}\n`);
    if (error instanceof CliUsageError) {
      dependencies.stderr.write(`Try 'invoice-fetcher --help' for usage.\n`);
    }
    return 1;
  }
}

const isDirectExecution =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  process.exitCode = await main();
}
