import path from "node:path";

import {
  parseAccountCommand,
  type AccountCommand,
} from "./accounts/index.js";
import type { CliOptions } from "./types.js";

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export const USAGE = `Usage:
  invoice-fetcher <start-date> <end-date> <email-inbox-to-search-through> <destination-folder-for-invoices>
  invoice-fetcher add imap <email> [--replace]
  invoice-fetcher add google <email> [--oauth-client <client-json>] [--replace]
  invoice-fetcher list
  invoice-fetcher remove <email>

Arguments:
  start-date                       First received date to search (YYYY-MM-DD, inclusive)
  end-date                         Last received date to search (YYYY-MM-DD, inclusive)
  email-inbox-to-search-through    Configured account email address
  destination-folder-for-invoices Folder in which invoice attachments will be organized

Options:
  --oauth-client <client-json>  Use an existing Google Desktop OAuth client
  --replace                     Replace an existing configured account
  -h, --help                    Show this help
  -v, --version                 Show the version`;

export class CliUsageError extends Error {
  override readonly name = "CliUsageError";
}

export type ParsedCommand =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "account"; command: AccountCommand }
  | { kind: "run"; options: CliOptions };

function localDateFromIso(value: string, label: string): Date {
  const match = DATE_PATTERN.exec(value);
  if (!match) {
    throw new CliUsageError(`${label} must use YYYY-MM-DD format.`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year === 0 || month < 1 || month > 12 || day < 1 || day > 31) {
    throw new CliUsageError(`${label} is not a valid calendar date.`);
  }

  // Construct years below 100 without Date's legacy 1900 offset. Start on a
  // known-valid day so February 29 is validated against the requested year.
  const date = new Date(2000, 0, 1, 0, 0, 0, 0);
  date.setFullYear(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    throw new CliUsageError(`${label} is not a valid calendar date.`);
  }
  return date;
}

export function parseDateRange(
  startDate: string,
  endDate: string,
): Pick<
  CliOptions,
  "startDate" | "endDate" | "startInclusive" | "endExclusive" | "spansMultipleMonths"
> {
  const startInclusive = localDateFromIso(startDate, "start-date");
  const endInclusive = localDateFromIso(endDate, "end-date");
  if (startInclusive.getTime() > endInclusive.getTime()) {
    throw new CliUsageError("start-date must be on or before end-date.");
  }

  const endExclusive = new Date(endInclusive);
  endExclusive.setDate(endExclusive.getDate() + 1);

  return {
    startDate,
    endDate,
    startInclusive,
    endExclusive,
    spansMultipleMonths:
      startInclusive.getFullYear() !== endInclusive.getFullYear() ||
      startInclusive.getMonth() !== endInclusive.getMonth(),
  };
}

export function parseCommandLine(argv: readonly string[]): ParsedCommand {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    return { kind: "help" };
  }
  if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v")) {
    return { kind: "version" };
  }
  if (argv[0] === "add" || argv[0] === "list" || argv[0] === "remove") {
    if (argv.length === 2 && (argv[1] === "--help" || argv[1] === "-h")) {
      return { kind: "help" };
    }
    const command = parseAccountCommand(argv);
    if (command) return { kind: "account", command };
  }
  const positional: string[] = [];
  for (const argument of argv) positional.push(argument);
  if (positional.length !== 4) {
    throw new CliUsageError("Expected exactly four positional arguments.");
  }

  const [startDate, endDate, inboxEmail, destinationArgument] = positional;
  if (
    startDate === undefined ||
    endDate === undefined ||
    inboxEmail === undefined ||
    destinationArgument === undefined
  ) {
    throw new CliUsageError("Expected exactly four positional arguments.");
  }
  if (!EMAIL_PATTERN.test(inboxEmail)) {
    throw new CliUsageError("email-inbox-to-search-through must be a valid email address.");
  }
  if (destinationArgument.trim().length === 0 || destinationArgument.includes("\0")) {
    throw new CliUsageError("destination-folder-for-invoices must be a valid non-empty path.");
  }

  return {
    kind: "run",
    options: {
      ...parseDateRange(startDate, endDate),
      inboxEmail,
      destination: path.resolve(destinationArgument),
    },
  };
}
