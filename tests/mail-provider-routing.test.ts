import assert from "node:assert/strict";
import test from "node:test";

import type {
  MailSearchOptions,
  MailSearchResult,
  MailSource,
} from "../src/mail/types.js";
import { ProviderRoutingMailSource } from "../src/mail/provider-routing-source.js";

const options: MailSearchOptions = {
  accountEmail: "user@example.com",
  startInclusive: new Date("2026-07-01T00:00:00Z"),
  endExclusive: new Date("2026-07-11T00:00:00Z"),
  stagingDirectory: "/tmp/staging",
  keywords: ["invoice"],
};

function source(name: string, calls: string[]): MailSource {
  return {
    async search(): Promise<MailSearchResult> {
      calls.push(name);
      return { attachments: [], issues: [], scannedMessages: 0 };
    },
  };
}

test("provider router sends Google to Gmail and generic accounts to IMAP", async () => {
  const calls: string[] = [];
  let provider: "google" | "imap" = "google";
  const router = new ProviderRoutingMailSource(
    async () => provider,
    { google: source("gmail", calls), imap: source("imap", calls) },
  );

  await router.search(options);
  provider = "imap";
  await router.search(options);

  assert.deepEqual(calls, ["gmail", "imap"]);
});

test("provider router propagates resolver failures without touching a source", async () => {
  const calls: string[] = [];
  const expected = new Error("profile missing");
  const router = new ProviderRoutingMailSource(
    async () => { throw expected; },
    { google: source("gmail", calls), imap: source("imap", calls) },
  );

  await assert.rejects(router.search(options), (error: unknown) => error === expected);
  assert.deepEqual(calls, []);
});
