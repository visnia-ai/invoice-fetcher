import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  CliUsageError,
  parseCommandLine,
  parseDateRange,
} from "../src/arguments.js";

test("parses an inclusive same-month date range", () => {
  const parsed = parseDateRange("2026-02-01", "2026-02-28");

  assert.equal(parsed.startInclusive.getFullYear(), 2026);
  assert.equal(parsed.startInclusive.getMonth(), 1);
  assert.equal(parsed.startInclusive.getDate(), 1);
  assert.equal(parsed.startInclusive.getHours(), 0);
  assert.equal(parsed.endExclusive.getFullYear(), 2026);
  assert.equal(parsed.endExclusive.getMonth(), 2);
  assert.equal(parsed.endExclusive.getDate(), 1);
  assert.equal(parsed.spansMultipleMonths, false);
});

test("accepts leap days and computes the exclusive next day", () => {
  const parsed = parseDateRange("2024-02-29", "2024-02-29");
  assert.equal(parsed.endExclusive.getFullYear(), 2024);
  assert.equal(parsed.endExclusive.getMonth(), 2);
  assert.equal(parsed.endExclusive.getDate(), 1);
});

test("detects cross-month and cross-year ranges", () => {
  assert.equal(parseDateRange("2026-01-31", "2026-02-01").spansMultipleMonths, true);
  assert.equal(parseDateRange("2025-12-31", "2026-01-01").spansMultipleMonths, true);
});

test("rejects malformed and impossible dates", () => {
  for (const [start, end] of [
    ["2026-2-01", "2026-02-02"],
    ["2026-02-29", "2026-03-01"],
    ["2026-04-31", "2026-05-01"],
    ["0000-01-01", "0000-01-02"],
  ]) {
    assert.throws(() => parseDateRange(start, end), CliUsageError);
  }
});

test("rejects a reversed range", () => {
  assert.throws(
    () => parseDateRange("2026-03-02", "2026-03-01"),
    /start-date must be on or before end-date/u,
  );
});

test("parses the exact four positional arguments", () => {
  const parsed = parseCommandLine([
    "2026-01-01",
    "2026-01-31",
    "billing@example.com",
    "invoices",
  ]);

  assert.equal(parsed.kind, "run");
  if (parsed.kind === "run") {
    assert.equal(parsed.options.inboxEmail, "billing@example.com");
    assert.equal(parsed.options.destination, path.resolve("invoices"));
  }
});

test("recognizes help and version flags", () => {
  assert.deepEqual(parseCommandLine(["--help"]), { kind: "help" });
  assert.deepEqual(parseCommandLine(["-h"]), { kind: "help" });
  assert.deepEqual(parseCommandLine(["--version"]), { kind: "version" });
  assert.deepEqual(parseCommandLine(["-v"]), { kind: "version" });
});

test("parses account management commands", () => {
  assert.deepEqual(parseCommandLine(["list"]), {
    kind: "account",
    command: { kind: "list" },
  });
  assert.deepEqual(
    parseCommandLine([
      "add",
      "google",
      "me@example.com",
      "--replace",
    ]),
    {
      kind: "account",
      command: {
        kind: "add",
        provider: "google",
        email: "me@example.com",
        replace: true,
      },
    },
  );
  assert.deepEqual(parseCommandLine(["add", "google", "me@example.com"]), {
    kind: "account",
    command: {
      kind: "add",
      provider: "google",
      email: "me@example.com",
      replace: false,
    },
  });
  assert.throws(() => parseCommandLine(["account", "list"]), /exactly four/u);
});

test("rejects invalid arity, email addresses, and destinations", () => {
  assert.throws(() => parseCommandLine([]), /exactly four/u);
  assert.throws(
    () => parseCommandLine(["2026-01-01", "2026-01-02", "invalid", "out"]),
    /valid email/u,
  );
  assert.throws(
    () => parseCommandLine(["2026-01-01", "2026-01-02", "a@example.com", "  "]),
    /valid non-empty path/u,
  );
});
