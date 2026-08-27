import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { MailSourceError } from "../src/mail/types.js";
import {
  ImapMailSource,
  imapServerSearchCriteria,
  imapServerSearchWindow,
  selectReceivedMailboxes,
  type ImapClient,
  type ImapConnectionProfile,
  type ImapMailbox,
  type ImapMessageMetadata,
  type ImapProgressEvent,
  type ImapReceivedSearchOptions,
  type MimeExtractor,
} from "../src/imap/index.js";

const start = new Date("2026-04-01T00:00:00.000Z");
const end = new Date("2026-07-01T00:00:00.000Z");

test("IMAP server searches include a safety margin for timezone-less dates", () => {
  const window = imapServerSearchWindow(start, end);
  assert.equal(window.since.toISOString(), "2026-03-31T00:00:00.000Z");
  assert.equal(window.before.toISOString(), "2026-07-02T00:00:00.000Z");
});

test("Gmail attachment searches combine the date window with has:attachment", () => {
  assert.deepEqual(
    imapServerSearchCriteria(start, end, { hasAttachmentsOnly: true }),
    {
      since: new Date("2026-03-31T00:00:00.000Z"),
      before: new Date("2026-07-02T00:00:00.000Z"),
      gmailraw: "has:attachment",
    },
  );
  assert.deepEqual(
    imapServerSearchCriteria(start, end, { hasAttachmentsOnly: false }),
    imapServerSearchWindow(start, end),
  );
});

function passwordProfile(
  overrides: Partial<ImapConnectionProfile> = {},
): ImapConnectionProfile {
  return {
    provider: "imap",
    email: "billing@example.com",
    host: "mail.example.com",
    port: 993,
    tls: "implicit",
    username: "billing@example.com",
    authentication: { type: "password", password: "secret" },
    ...overrides,
  };
}

class FakeClient implements ImapClient {
  currentMailbox = "";
  connected = false;
  loggedOut = false;
  searchRanges: Array<[Date, Date]> = [];
  searchRequests: Array<ImapReceivedSearchOptions> = [];
  searchErrors: unknown[] = [];
  metadataBatchCalls: number[][] = [];
  downloadCalls = 0;
  readonly metadata = new Map<string, ImapMessageMetadata | Error>();
  readonly uids = new Map<string, readonly number[]>();
  readonly mailboxErrors = new Set<string>();
  readonly metadataBatchErrors = new Set<number>();

  constructor(readonly mailboxes: readonly ImapMailbox[]) {}

  async connect(): Promise<void> {
    this.connected = true;
  }

  async listMailboxes(): Promise<readonly ImapMailbox[]> {
    return this.mailboxes;
  }

  async lockMailbox(path: string): Promise<{ release(): void }> {
    if (this.mailboxErrors.has(path)) throw new Error("mailbox unavailable");
    this.currentMailbox = path;
    return { release: () => undefined };
  }

  async searchReceived(
    since: Date,
    before: Date,
    options: ImapReceivedSearchOptions,
  ): Promise<readonly number[]> {
    this.searchRanges.push([since, before]);
    this.searchRequests.push(options);
    const error = this.searchErrors.shift();
    if (error !== undefined) throw error;
    return this.uids.get(this.currentMailbox) ?? [];
  }

  async fetchMetadataBatch(uids: readonly number[]) {
    this.metadataBatchCalls.push([...uids]);
    if (uids.some((uid) => this.metadataBatchErrors.has(uid))) {
      throw new Error("metadata batch unavailable");
    }
    return uids.map((uid) => {
      const value = this.metadata.get(`${this.currentMailbox}:${uid}`);
      if (value instanceof Error) {
        return { kind: "error" as const, uid, message: value.message };
      }
      if (!value || Number.isNaN(value.receivedAt.getTime())) {
        return { kind: "error" as const, uid, message: "invalid fake metadata" };
      }
      return { kind: "success" as const, uid, metadata: value };
    });
  }

  async downloadMessage(): Promise<Readable> {
    this.downloadCalls += 1;
    return Readable.from("mime source");
  }

  async downloadPart(): Promise<{ content: Readable }> {
    return { content: Readable.from("part source") };
  }

  async logout(): Promise<void> {
    this.loggedOut = true;
  }
}

function mailbox(path: string, specialUse?: string): ImapMailbox {
  return {
    path,
    delimiter: "/",
    ...(specialUse ? { specialUse } : {}),
    selectable: true,
  };
}

function metadata(
  uid: number,
  overrides: Partial<ImapMessageMetadata> = {},
): ImapMessageMetadata {
  return {
    uid,
    messageId: `<message-${uid}@example.com>`,
    receivedAt: new Date("2026-05-10T12:00:00.000Z"),
    sender: "Vendor <accounts@vendor.example>",
    subject: "May invoice",
    hasAttachments: true,
    ...overrides,
  };
}

const extractor: MimeExtractor = {
  async extract(request) {
    request.source.resume();
    return {
      attachments: [
        {
          attachmentId: "1:invoice.pdf",
          stagedPath: join(request.stagingDirectory, "staged-invoice.pdf"),
          originalName: "invoice.pdf",
          mimeType: "application/pdf",
          size: 123,
        },
      ],
      emailContextMatches: request.subject.includes("invoice"),
      emailReceiptMatches: request.subject.includes("receipt"),
      issues: [],
    };
  },
};

async function withStaging(
  callback: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "invoice-fetcher-imap-test-"));
  try {
    await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("selectReceivedMailboxes excludes special-use roots and descendants", () => {
  const selected = selectReceivedMailboxes(
    [
      mailbox("Inbox", "\\Inbox"),
      mailbox("Archive", "\\Archive"),
      mailbox("Projects"),
      mailbox("Sent", "\\Sent"),
      mailbox("Sent/Receipts"),
      mailbox("Trash", "\\Trash"),
      mailbox("Drafts"),
      mailbox("[Provider]/Junk Email"),
      mailbox("Clients/Sent"),
      { ...mailbox("Containers"), selectable: false },
    ],
    "imap",
  );
  assert.deepEqual(selected.map((entry) => entry.path), [
    "Inbox",
    "Archive",
    "Projects",
    "Clients/Sent",
  ]);
});

test("Google prefers All Mail over traversing duplicate mailboxes", () => {
  const selected = selectReceivedMailboxes(
    [mailbox("INBOX", "\\Inbox"), mailbox("[Gmail]/All Mail", "\\All")],
    "google",
  );
  assert.deepEqual(selected.map((entry) => entry.path), ["[Gmail]/All Mail"]);
});

test("Google recognizes conventional All Mail when SPECIAL-USE flags are absent", () => {
  const selected = selectReceivedMailboxes(
    [mailbox("INBOX"), mailbox("[Gmail]/All Mail"), mailbox("[Gmail]/Sent Mail")],
    "google",
  );
  assert.deepEqual(selected.map((entry) => entry.path), ["[Gmail]/All Mail"]);
});

test("search applies exact dates, Gmail excluded labels, and stable message deduplication", async () => {
  await withStaging(async (directory) => {
    const client = new FakeClient([
      mailbox("INBOX", "\\Inbox"),
      mailbox("[Gmail]/All Mail", "\\All"),
    ]);
    client.uids.set("[Gmail]/All Mail", [1, 2, 3, 4]);
    client.metadata.set("[Gmail]/All Mail:1", metadata(1));
    client.metadata.set(
      "[Gmail]/All Mail:2",
      metadata(2, { receivedAt: end }),
    );
    client.metadata.set(
      "[Gmail]/All Mail:3",
      metadata(3, { labels: new Set(["\\Sent"]) }),
    );
    client.metadata.set(
      "[Gmail]/All Mail:4",
      metadata(4, { messageId: "<message-1@example.com>" }),
    );
    const events: ImapProgressEvent[] = [];
    const source = new ImapMailSource(
      async () =>
        passwordProfile({
          provider: "google",
          host: "imap.gmail.com",
          authentication: { type: "oauth2", accessToken: "token" },
        }),
      { clientFactory: () => client, mimeExtractor: extractor },
    );

    const result = await source.search({
      accountEmail: "billing@example.com",
      startInclusive: start,
      endExclusive: end,
      stagingDirectory: directory,
      keywords: ["invoice"],
      onProgress: (event) => events.push(event),
    });

    assert.equal(result.scannedMessages, 4);
    assert.equal(result.attachments.length, 1);
    assert.equal(result.attachments[0]?.messageId, "<message-1@example.com>");
    assert.equal(result.attachments[0]?.emailContextMatches, true);
    assert.deepEqual(client.searchRanges, [[start, end]]);
    assert.deepEqual(client.searchRequests, [{ hasAttachmentsOnly: true }]);
    assert.equal(client.loggedOut, true);
    assert.deepEqual(
      events.filter((event) => event.type === "mailbox-started").map((event) =>
        event.type === "mailbox-started" ? event.mailboxName : "",
      ),
      ["[Gmail]/All Mail"],
    );
    assert.equal(events.at(-1)?.type, "search-completed");
  });
});

test("ordinary IMAP deduplicates a message found in multiple received folders", async () => {
  await withStaging(async (directory) => {
    const client = new FakeClient([mailbox("INBOX"), mailbox("Archive")]);
    client.uids.set("INBOX", [1]);
    client.uids.set("Archive", [9]);
    client.metadata.set("INBOX:1", metadata(1, { messageId: "<same@example.com>" }));
    client.metadata.set("Archive:9", metadata(9, { messageId: "<SAME@example.com>" }));
    const source = new ImapMailSource(async () => passwordProfile(), {
      clientFactory: () => client,
      mimeExtractor: extractor,
    });
    const result = await source.search({
      accountEmail: "billing@example.com",
      startInclusive: start,
      endExclusive: end,
      stagingDirectory: directory,
      keywords: ["invoice"],
    });
    assert.equal(result.scannedMessages, 2);
    assert.equal(result.attachments.length, 1);
    assert.ok(client.searchRequests.every((request) => !request.hasAttachmentsOnly));
  });
});

test("Google silently retries without raw filtering when the extension is unavailable", async () => {
  await withStaging(async (directory) => {
    const client = new FakeClient([mailbox("[Gmail]/All Mail", "\\All")]);
    client.searchErrors.push(
      Object.assign(new Error("X-GM-EXT-1 is unavailable"), {
        code: "MissingServerExtension",
      }),
    );
    client.uids.set("[Gmail]/All Mail", [1]);
    client.metadata.set("[Gmail]/All Mail:1", metadata(1));
    const source = new ImapMailSource(
      async () =>
        passwordProfile({
          provider: "google",
          host: "imap.gmail.com",
          authentication: { type: "oauth2", accessToken: "token" },
        }),
      { clientFactory: () => client, mimeExtractor: extractor },
    );

    const result = await source.search({
      accountEmail: "billing@example.com",
      startInclusive: start,
      endExclusive: end,
      stagingDirectory: directory,
      keywords: ["invoice"],
    });

    assert.deepEqual(client.searchRequests, [
      { hasAttachmentsOnly: true },
      { hasAttachmentsOnly: false },
    ]);
    assert.equal(result.scannedMessages, 1);
    assert.equal(result.attachments.length, 1);
    assert.equal(result.issues.length, 0);
  });
});

test("Google does not hide unrelated server search failures", async () => {
  await withStaging(async (directory) => {
    const client = new FakeClient([mailbox("[Gmail]/All Mail", "\\All")]);
    client.searchErrors.push(Object.assign(new Error("connection lost"), { code: "ECONNRESET" }));
    const source = new ImapMailSource(
      async () =>
        passwordProfile({
          provider: "google",
          host: "imap.gmail.com",
          authentication: { type: "oauth2", accessToken: "token" },
        }),
      { clientFactory: () => client, mimeExtractor: extractor },
    );

    const result = await source.search({
      accountEmail: "billing@example.com",
      startInclusive: start,
      endExclusive: end,
      stagingDirectory: directory,
      keywords: ["invoice"],
    });

    assert.deepEqual(client.searchRequests, [{ hasAttachmentsOnly: true }]);
    assert.deepEqual(result.issues.map((issue) => issue.code), ["MAILBOX_READ_FAILED"]);
  });
});

test("mailbox and message failures are collected as partial issues", async () => {
  await withStaging(async (directory) => {
    const client = new FakeClient([mailbox("INBOX"), mailbox("Archive")]);
    client.uids.set("INBOX", [1]);
    client.metadata.set("INBOX:1", new Error("message vanished"));
    client.mailboxErrors.add("Archive");
    const source = new ImapMailSource(async () => passwordProfile(), {
      clientFactory: () => client,
      mimeExtractor: extractor,
    });
    const result = await source.search({
      accountEmail: "billing@example.com",
      startInclusive: start,
      endExclusive: end,
      stagingDirectory: directory,
      keywords: ["invoice"],
    });
    assert.deepEqual(result.issues.map((issue) => issue.code), [
      "MESSAGE_READ_FAILED",
      "MAILBOX_READ_FAILED",
    ]);
    assert.equal(client.loggedOut, true);
  });
});

test("progress callback failures never stop collection and counts every 25 messages", async () => {
  await withStaging(async (directory) => {
    const client = new FakeClient([mailbox("INBOX")]);
    client.uids.set("INBOX", Array.from({ length: 25 }, (_, index) => index + 1));
    for (let uid = 1; uid <= 25; uid += 1) {
      client.metadata.set(`INBOX:${uid}`, metadata(uid, { hasAttachments: false }));
    }
    const observed: ImapProgressEvent[] = [];
    const source = new ImapMailSource(async () => passwordProfile(), {
      clientFactory: () => client,
      mimeExtractor: extractor,
    });
    const result = await source.search({
      accountEmail: "billing@example.com",
      startInclusive: start,
      endExclusive: end,
      stagingDirectory: directory,
      keywords: ["invoice"],
      onProgress: (event) => {
        observed.push(event);
        if (event.type === "authenticated") throw new Error("formatter bug");
      },
    });
    assert.equal(result.scannedMessages, 25);
    assert.ok(
      observed.some(
        (event) => event.type === "scan-started" && event.totalMessages === 25,
      ),
    );
    assert.ok(
      observed.some(
        (event) => event.type === "messages-scanned" && event.scannedMessages === 25,
      ),
    );
    assert.equal(client.downloadCalls, 0);
  });
});

test("metadata is fetched in ordered batches of 250 UIDs", async () => {
  await withStaging(async (directory) => {
    const client = new FakeClient([mailbox("INBOX")]);
    const uids = Array.from({ length: 501 }, (_, index) => index + 1);
    client.uids.set("INBOX", uids);
    for (const uid of uids) {
      client.metadata.set(`INBOX:${uid}`, metadata(uid, { hasAttachments: false }));
    }
    const source = new ImapMailSource(async () => passwordProfile(), {
      clientFactory: () => client,
      mimeExtractor: extractor,
    });

    const result = await source.search({
      accountEmail: "billing@example.com",
      startInclusive: start,
      endExclusive: end,
      stagingDirectory: directory,
      keywords: ["invoice"],
    });

    assert.equal(result.scannedMessages, 501);
    assert.equal(result.issues.length, 0);
    assert.deepEqual(client.metadataBatchCalls.map((batch) => batch.length), [250, 250, 1]);
    assert.deepEqual(client.metadataBatchCalls.flat(), uids);
  });
});

test("missing and malformed metadata fail individually without stopping the batch", async () => {
  await withStaging(async (directory) => {
    const client = new FakeClient([mailbox("INBOX")]);
    client.uids.set("INBOX", [1, 2, 3]);
    client.metadata.set("INBOX:1", metadata(1, { hasAttachments: false }));
    client.metadata.set("INBOX:2", metadata(2, { receivedAt: new Date(Number.NaN) }));
    const source = new ImapMailSource(async () => passwordProfile(), {
      clientFactory: () => client,
      mimeExtractor: extractor,
    });

    const result = await source.search({
      accountEmail: "billing@example.com",
      startInclusive: start,
      endExclusive: end,
      stagingDirectory: directory,
      keywords: ["invoice"],
    });

    assert.equal(result.scannedMessages, 3);
    assert.deepEqual(result.issues.map((issue) => issue.code), [
      "MESSAGE_READ_FAILED",
      "MESSAGE_READ_FAILED",
    ]);
    assert.deepEqual(client.metadataBatchCalls, [[1, 2, 3]]);
  });
});

test("a failed metadata batch records each UID and continues with later batches", async () => {
  await withStaging(async (directory) => {
    const client = new FakeClient([mailbox("INBOX")]);
    const uids = Array.from({ length: 251 }, (_, index) => index + 1);
    client.uids.set("INBOX", uids);
    client.metadataBatchErrors.add(1);
    client.metadata.set("INBOX:251", metadata(251, { hasAttachments: false }));
    const source = new ImapMailSource(async () => passwordProfile(), {
      clientFactory: () => client,
      mimeExtractor: extractor,
    });

    const result = await source.search({
      accountEmail: "billing@example.com",
      startInclusive: start,
      endExclusive: end,
      stagingDirectory: directory,
      keywords: ["invoice"],
    });

    assert.equal(result.scannedMessages, 251);
    assert.equal(result.issues.length, 250);
    assert.ok(result.issues.every((issue) => issue.code === "MESSAGE_READ_FAILED"));
    assert.deepEqual(client.metadataBatchCalls.map((batch) => batch.length), [250, 1]);
  });
});

test("connection failures are fatal MailSourceError values", async () => {
  await withStaging(async (directory) => {
    const source = new ImapMailSource(async () => passwordProfile(), {
      clientFactory: () => {
        throw new Error("certificate rejected");
      },
      mimeExtractor: extractor,
    });
    await assert.rejects(
      source.search({
        accountEmail: "billing@example.com",
        startInclusive: start,
        endExclusive: end,
        stagingDirectory: directory,
        keywords: ["invoice"],
      }),
      (error: unknown) =>
        error instanceof MailSourceError &&
        error.code === "MAIL_ACCESS_FAILED" &&
        error.message.includes("certificate rejected"),
    );
  });
});

test("profiles enforce provider authentication and encrypted transport", async () => {
  await withStaging(async (directory) => {
    const invalidProfiles: ImapConnectionProfile[] = [
      passwordProfile({ provider: "google" }),
      passwordProfile({ authentication: { type: "oauth2", accessToken: "token" } }),
      { ...passwordProfile(), tls: "plain" as "implicit" },
    ];
    for (const profile of invalidProfiles) {
      const source = new ImapMailSource(async () => profile, {
        clientFactory: () => {
          throw new Error("should not construct client");
        },
        mimeExtractor: extractor,
      });
      await assert.rejects(
        source.search({
          accountEmail: profile.email,
          startInclusive: start,
          endExclusive: end,
          stagingDirectory: directory,
          keywords: ["invoice"],
        }),
        (error: unknown) => error instanceof MailSourceError && error.code === "INVALID_REQUEST",
      );
    }
  });
});
