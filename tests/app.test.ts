import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { runApplication, type ApplicationDependencies } from "../src/app.js";
import type {
  MailAttachmentCandidate,
  MailSearchOptions,
  MailSearchResult,
  MailSource,
} from "../src/mail/index.js";
import type { CliOptions } from "../src/types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("runApplication", () => {
  it("copies classified invoices and cleans its staging directory", async () => {
    const root = await makeRoot();
    const staging = path.join(root, "staging");
    const source = new FakeMailSource(async (searchOptions) => {
      searchOptions.onProgress?.({ type: "account-selected", accountName: "Example" });
      searchOptions.onProgress?.({
        type: "mailbox-started",
        mailboxName: "Archive",
        scannedMessages: 0,
        totalMessages: 1,
        attachmentsStaged: 0,
      });
      searchOptions.onProgress?.({
        type: "mailbox-completed",
        mailboxName: "Archive",
        scannedMessages: 1,
        totalMessages: 1,
        attachmentsStaged: 1,
      });
      await writeFile(path.join(staging, "candidate.pdf"), "invoice data");
      return {
        scannedMessages: 1,
        issues: [],
        attachments: [{
          ...pdfCandidate(staging, "invoice-2026.pdf"),
          stagedPath: path.join(staging, "candidate.pdf"),
          sender: "Vendor <billing@eu.example.com>",
          receivedAt: new Date(2026, 1, 3),
        }],
      };
    });
    const output: string[] = [];

    const result = await runApplication(options(root, true), dependencies(source, staging, output));

    assert.equal(result.exitCode, 0);
    assert.equal(result.copied, 1);
    assert.equal(
      await readFile(
        path.join(root, "invoices", "2026-02", "eu.example.com", "invoice-2026.pdf"),
        "utf8",
      ),
      "invoice data",
    );
    await assert.rejects(readFile(staging));
    assert.match(output.join(""), /1 copied/u);
    assert.match(output.join(""), /selected account “Example”/u);
    assert.match(output.join(""), /scanning mailbox “Archive”/u);
    assert.match(output.join(""), /Mail search complete/u);
  });

  it("rejects unexpected non-PDF candidates without copying", async () => {
    const root = await makeRoot();
    const staging = path.join(root, "staging");
    const source = new FakeMailSource(async () => {
      await writeFile(path.join(staging, "invoice.png"), "image");
      return {
        scannedMessages: 1,
        issues: [],
        attachments: [{
          ...pdfCandidate(staging, "invoice.png"),
          mimeType: "application/pdf",
        }],
      };
    });

    const result = await runApplication(options(root, false), dependencies(source, staging, []));

    assert.equal(result.copied, 0);
    assert.equal(result.rejected, 1);
  });

  it("processes a streamed attachment only once when it is also returned", async () => {
    const root = await makeRoot();
    const staging = path.join(root, "staging");
    const candidate = pdfCandidate(staging, "invoice-streamed.pdf");
    const source = new FakeMailSource(async (searchOptions) => {
      await writeFile(candidate.stagedPath, "invoice data");
      await searchOptions.onAttachment?.(candidate);
      return { scannedMessages: 1, issues: [], attachments: [candidate] };
    });

    const result = await runApplication(
      options(root, false),
      dependencies(source, staging, []),
    );

    assert.equal(result.copied, 1);
    assert.equal(result.deduplicated, 0);
  });

  it("drains streamed work before staging cleanup after a fatal search error", async () => {
    const root = await makeRoot();
    const staging = path.join(root, "staging");
    const candidate = pdfCandidate(staging, "invoice-fatal.pdf");
    let stagingRemoved = false;
    const source = new FakeMailSource(async (searchOptions) => {
      await writeFile(candidate.stagedPath, "invoice data");
      await searchOptions.onAttachment?.(candidate);
      throw new Error("search failed");
    });
    const deps = dependencies(source, staging, []);
    deps.removeStagingDirectory = async (directory) => {
      assert.equal(
        await readFile(path.join(root, "invoices", "vendor.example", "invoice-fatal.pdf"), "utf8"),
        "invoice data",
      );
      stagingRemoved = true;
      await rm(directory, { recursive: true, force: true });
    };

    await assert.rejects(runApplication(options(root, false), deps), /search failed/u);
    assert.equal(stagingRemoved, true);
  });

  it("continues after source issues and returns partial-failure status", async () => {
    const root = await makeRoot();
    const staging = path.join(root, "staging");
    const source = new FakeMailSource(async () => ({
      scannedMessages: 2,
      attachments: [],
      issues: [{ code: "ATTACHMENT_SAVE_FAILED", message: "download failed" }],
    }));
    const output: string[] = [];

    const result = await runApplication(options(root, false), dependencies(source, staging, output));

    assert.equal(result.exitCode, 2);
    assert.equal(result.failed, 1);
    assert.match(output.join(""), /ATTACHMENT_SAVE_FAILED/u);
  });

  it("runs on Linux and Windows", async () => {
    for (const platform of ["linux", "win32"] as const) {
      const root = await makeRoot();
      const source = new FakeMailSource(async () => ({
        scannedMessages: 0,
        attachments: [],
        issues: [],
      }));
      const deps = dependencies(source, path.join(root, "staging"), []);
      deps.platform = platform;

      await runApplication(options(root, false), deps);
      assert.equal(source.calls, 1);
    }
  });

  it("rejects unsupported operating systems before searching", async () => {
    const root = await makeRoot();
    const source = new FakeMailSource(async () => ({
      scannedMessages: 0,
      attachments: [],
      issues: [],
    }));
    const deps = dependencies(source, path.join(root, "staging"), []);
    deps.platform = "aix";

    await assert.rejects(runApplication(options(root, false), deps), /Unsupported operating system/u);
    assert.equal(source.calls, 0);
  });

  it("refreshes and clears mail progress with the latest counts", async () => {
    const root = await makeRoot();
    const staging = path.join(root, "staging");
    let scheduledCallback: (() => void) | undefined;
    let intervalMilliseconds = 0;
    let cancelled = false;
    let currentTime = 0;
    const source = new FakeMailSource(async (searchOptions) => {
      searchOptions.onProgress?.({
        type: "messages-scanned",
        scannedMessages: 25,
        totalMessages: 100,
        attachmentsStaged: 3,
      });
      currentTime = 15_000;
      scheduledCallback?.();
      return { scannedMessages: 25, attachments: [], issues: [] };
    });
    const output: string[] = [];
    const deps = dependencies(source, staging, output);
    deps.stdout = {
      isTTY: true,
      columns: 100,
      write: (chunk) => output.push(String(chunk)),
    };
    deps.now = () => currentTime;
    deps.scheduleInterval = (callback, milliseconds) => {
      scheduledCallback = callback;
      intervalMilliseconds = milliseconds;
      return "heartbeat";
    };
    deps.cancelInterval = (handle) => {
      assert.equal(handle, "heartbeat");
      cancelled = true;
    };

    await runApplication(options(root, false), deps);

    assert.equal(intervalMilliseconds, 15_000);
    assert.equal(cancelled, true);
    assert.match(output.join(""), /25% • 25\/100 messages • 3 attachments • ETA 45s/u);
  });
});

class FakeMailSource implements MailSource {
  calls = 0;

  constructor(
    private readonly response: (options: MailSearchOptions) => Promise<MailSearchResult>,
  ) {}

  async search(options: MailSearchOptions): Promise<MailSearchResult> {
    this.calls += 1;
    return this.response(options);
  }
}

function dependencies(
  source: MailSource,
  staging: string,
  output: string[],
): ApplicationDependencies {
  return {
    mailSource: source,
    stdout: { write: (chunk) => output.push(String(chunk)) },
    stderr: { write: (chunk) => output.push(String(chunk)) },
    platform: "darwin",
    createStagingDirectory: async () => {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(staging, { recursive: true });
      return staging;
    },
    removeStagingDirectory: (directory) => rm(directory, { recursive: true, force: true }),
    scheduleInterval: () => "heartbeat",
    cancelInterval: () => undefined,
    now: () => 0,
  };
}

function options(root: string, spansMultipleMonths: boolean): CliOptions {
  return {
    startDate: "2026-01-01",
    endDate: spansMultipleMonths ? "2026-02-28" : "2026-01-31",
    startInclusive: new Date(2026, 0, 1),
    endExclusive: spansMultipleMonths ? new Date(2026, 2, 1) : new Date(2026, 1, 1),
    inboxEmail: "me@example.com",
    destination: path.join(root, "invoices"),
    spansMultipleMonths,
  };
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "invoice-app-test-"));
  roots.push(root);
  return root;
}

function pdfCandidate(staging: string, originalName: string): MailAttachmentCandidate {
  return {
    messageId: "streamed-message",
    attachmentId: originalName,
    stagedPath: path.join(staging, originalName),
    originalName,
    mimeType: "application/pdf",
    size: 5,
    sender: "Vendor <billing@vendor.example>",
    receivedAt: new Date(2026, 0, 3),
    emailContextMatches: false,
    emailReceiptMatches: false,
  };
}
