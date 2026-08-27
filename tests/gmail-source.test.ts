import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { text } from "node:stream/consumers";
import test from "node:test";

import {
  GmailApiMailSource,
  gmailSearchQuery,
} from "../src/gmail/gmail-mail-source.js";
import type {
  GmailApiAttachment,
  GmailApiClient,
  GmailApiConnectionProfile,
  GmailApiListPage,
  GmailApiMessage,
  GmailApiMessagePart,
} from "../src/gmail/types.js";
import { MailSourceError, type MailProgressEvent } from "../src/mail/types.js";
import type { MimeExtractor } from "../src/imap/types.js";

const start = new Date("2026-07-01T00:00:00.000Z");
const end = new Date("2026-07-10T00:00:00.000Z");

function profile(): GmailApiConnectionProfile {
  return {
    email: "pierre@example.com",
    accessToken: "memory-only-access-token",
    expiresAt: new Date("2026-07-10T01:00:00.000Z"),
    tokenType: "Bearer",
    scope: "https://www.googleapis.com/auth/gmail.readonly",
    oauthClient: { clientId: "client-id" },
  };
}

class FakeGmailClient implements GmailApiClient {
  profileEmail = "pierre@example.com";
  readonly listPages = new Map<string, GmailApiListPage>();
  readonly messages = new Map<string, GmailApiMessage | Error>();
  readonly raws = new Map<string, string | Error>();
  readonly attachmentBodies = new Map<string, GmailApiAttachment | Error>();
  readonly listCalls: Array<{
    query: string;
    maxResults: number;
    pageToken?: string;
  }> = [];
  readonly messageCalls: string[] = [];
  readonly rawCalls: string[] = [];
  readonly attachmentCalls: string[] = [];
  messageDelay = new Map<string, number>();
  activeMessageGets = 0;
  maximumActiveMessageGets = 0;

  async getProfile(): Promise<{ emailAddress: string }> {
    return { emailAddress: this.profileEmail };
  }

  async listMessages(input: {
    query: string;
    maxResults: number;
    pageToken?: string;
  }): Promise<GmailApiListPage> {
    this.listCalls.push(input);
    return this.listPages.get(input.pageToken ?? "") ?? { messageIds: [] };
  }

  async getMessage(messageId: string): Promise<GmailApiMessage> {
    this.messageCalls.push(messageId);
    this.activeMessageGets += 1;
    this.maximumActiveMessageGets = Math.max(
      this.maximumActiveMessageGets,
      this.activeMessageGets,
    );
    try {
      const delay = this.messageDelay.get(messageId) ?? 0;
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      const result = this.messages.get(messageId);
      if (result instanceof Error) throw result;
      if (!result) throw new Error(`Missing fake message ${messageId}`);
      return result;
    } finally {
      this.activeMessageGets -= 1;
    }
  }

  async getRawMessage(messageId: string): Promise<string> {
    this.rawCalls.push(messageId);
    const result = this.raws.get(messageId);
    if (result instanceof Error) throw result;
    if (result === undefined) throw new Error(`Missing fake raw message ${messageId}`);
    return result;
  }

  async getAttachment(
    messageId: string,
    attachmentId: string,
  ): Promise<GmailApiAttachment> {
    const key = `${messageId}:${attachmentId}`;
    this.attachmentCalls.push(key);
    const result = this.attachmentBodies.get(key);
    if (result instanceof Error) throw result;
    if (!result) throw new Error(`Missing fake attachment ${key}`);
    return result;
  }
}

function gmailMessage(input: {
  id: string;
  date: Date;
  rfcMessageId?: string;
  filename?: string;
  content?: string;
  externalAttachmentId?: string;
  labels?: readonly string[];
  subject?: string;
  payload?: GmailApiMessagePart;
}): GmailApiMessage {
  const headers = [
    { name: "From", value: `Vendor ${input.id} <billing@example.com>` },
    { name: "Subject", value: input.subject ?? "Invoice available" },
    ...(input.rfcMessageId
      ? [{ name: "Message-ID", value: input.rfcMessageId }]
      : []),
  ];
  const filename = input.filename ?? `${input.id}.pdf`;
  const attachment: GmailApiMessagePart = {
    partId: "1",
    mimeType: "application/pdf",
    filename,
    headers: [{ name: "Content-Disposition", value: `attachment; filename=${filename}` }],
    body: {
      size: Buffer.byteLength(input.content ?? input.id),
      ...(input.externalAttachmentId
        ? { attachmentId: input.externalAttachmentId }
        : { data: Buffer.from(input.content ?? input.id).toString("base64url") }),
    },
    parts: [],
  };
  return {
    id: input.id,
    labelIds: input.labels ?? ["INBOX"],
    internalDate: String(input.date.getTime()),
    payload: input.payload ?? {
      partId: "",
      mimeType: "multipart/mixed",
      filename: "",
      headers,
      body: { size: 0 },
      parts: [attachment],
    },
  };
}

function source(client: FakeGmailClient, mimeExtractor?: MimeExtractor): GmailApiMailSource {
  return new GmailApiMailSource(async () => profile(), {
    clientFactory: () => client,
    ...(mimeExtractor ? { mimeExtractor } : {}),
  });
}

async function withStaging(
  callback: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "invoice-fetcher-gmail-test-"));
  try {
    await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function searchOptions(directory: string) {
  return {
    accountEmail: "pierre@example.com",
    startInclusive: start,
    endExclusive: end,
    stagingDirectory: directory,
    keywords: ["invoice"],
  };
}

test("Gmail API search paginates broadly, filters exactly, and publishes deterministically", async () => {
  await withStaging(async (directory) => {
    const client = new FakeGmailClient();
    client.listPages.set("", {
      messageIds: ["late", "boundary", "sent"],
      nextPageToken: "page-2",
    });
    client.listPages.set("page-2", { messageIds: ["early", "late"] });
    client.messages.set("late", gmailMessage({
      id: "late",
      date: new Date("2026-07-08T12:00:00.000Z"),
      rfcMessageId: "<late@example.com>",
    }));
    client.messages.set("early", gmailMessage({
      id: "early",
      date: new Date("2026-07-02T12:00:00.000Z"),
      rfcMessageId: "<early@example.com>",
    }));
    client.messages.set("boundary", gmailMessage({
      id: "boundary",
      date: end,
      rfcMessageId: "<boundary@example.com>",
    }));
    client.messages.set("sent", gmailMessage({
      id: "sent",
      date: new Date("2026-07-03T12:00:00.000Z"),
      labels: ["SENT"],
      rfcMessageId: "<sent@example.com>",
    }));
    client.messageDelay.set("early", 20);
    const events: MailProgressEvent[] = [];
    const streamed: string[] = [];

    const result = await source(client).search({
      ...searchOptions(directory),
      onProgress: (event) => events.push(event),
      onAttachment: async (attachment) => {
        streamed.push(attachment.originalName);
      },
    });

    assert.deepEqual(result.attachments.map((attachment) => attachment.originalName), [
      "early.pdf",
      "late.pdf",
    ]);
    assert.deepEqual(streamed, ["early.pdf", "late.pdf"]);
    assert.equal(result.scannedMessages, 4);
    assert.equal(result.issues.length, 0);
    assert.equal(client.listCalls.length, 2);
    assert.deepEqual(client.listCalls.map((call) => call.maxResults), [500, 500]);
    assert.equal(client.listCalls[0]?.query, gmailSearchQuery(start, end));
    assert.equal(
      client.listCalls[0]?.query,
      "after:2026/06/29 before:2026/07/11 has:attachment",
    );
    assert.deepEqual(
      events.filter((event) => event.type === "mailbox-started" || event.type === "mailbox-completed")
        .map((event) => "mailboxName" in event ? event.mailboxName : undefined),
      ["Google All Mail", "Google All Mail"],
    );
    const completed = events.at(-1);
    assert.deepEqual(completed, {
      type: "search-completed",
      scannedMessages: 4,
      totalMessages: 4,
      attachmentsStaged: 2,
    });
  });
});

test("failed duplicate occurrences permit a later success and successful occurrences suppress later duplicates", async () => {
  await withStaging(async (directory) => {
    const client = new FakeGmailClient();
    client.listPages.set("", { messageIds: ["failed", "success", "suppressed"] });
    const duplicate = "<duplicate@example.com>";
    client.messages.set("failed", gmailMessage({
      id: "failed",
      date: new Date("2026-07-02T10:00:00.000Z"),
      rfcMessageId: duplicate,
      externalAttachmentId: "broken-body",
    }));
    client.messages.set("success", gmailMessage({
      id: "success",
      date: new Date("2026-07-02T11:00:00.000Z"),
      rfcMessageId: duplicate,
    }));
    client.messages.set("suppressed", gmailMessage({
      id: "suppressed",
      date: new Date("2026-07-02T12:00:00.000Z"),
      rfcMessageId: duplicate,
      externalAttachmentId: "must-not-download",
    }));
    client.attachmentBodies.set(
      "failed:broken-body",
      new Error("attachment unavailable"),
    );
    client.raws.set("failed", new Error("raw unavailable"));

    const result = await source(client).search(searchOptions(directory));

    assert.equal(result.scannedMessages, 3);
    assert.deepEqual(result.attachments.map((attachment) => attachment.originalName), [
      "success.pdf",
    ]);
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0]?.messageId, duplicate);
    assert.match(result.issues[0]?.message ?? "", /raw unavailable/u);
    assert.deepEqual(client.attachmentCalls, ["failed:broken-body"]);
    assert.deepEqual(client.rawCalls, ["failed"]);
  });
});

test("malformed Gmail MIME falls back transactionally to strict raw MIME extraction", async () => {
  await withStaging(async (directory) => {
    const client = new FakeGmailClient();
    client.listPages.set("", { messageIds: ["nested"] });
    client.messages.set("nested", gmailMessage({
      id: "nested",
      date: new Date("2026-07-04T10:00:00.000Z"),
      rfcMessageId: "<nested@example.com>",
      payload: {
        partId: "1",
        mimeType: "message/rfc822",
        filename: "forwarded.eml",
        headers: [
          { name: "Message-ID", value: "<nested@example.com>" },
          { name: "Subject", value: "Invoice forwarded" },
          { name: "From", value: "Sender <sender@example.com>" },
        ],
        body: { data: Buffer.from("nested").toString("base64url") },
        parts: [],
      },
    }));
    client.raws.set("nested", Buffer.from("raw MIME bytes").toString("base64url"));
    const rawPath = join(directory, "raw-invoice.pdf");
    let parsedSource = "";
    const extractor: MimeExtractor = {
      async extract(request) {
        parsedSource = await text(request.source);
        await writeFile(rawPath, "pdf");
        return {
          attachments: [{
            attachmentId: "1:raw-invoice.pdf",
            stagedPath: rawPath,
            originalName: "raw-invoice.pdf",
            mimeType: "application/pdf",
            size: 3,
          }],
          emailContextMatches: true,
          emailReceiptMatches: false,
          issues: [],
        };
      },
    };

    const result = await source(client, extractor).search(searchOptions(directory));

    assert.equal(parsedSource, "raw MIME bytes");
    assert.deepEqual(client.rawCalls, ["nested"]);
    assert.deepEqual(result.attachments.map((attachment) => attachment.originalName), [
      "raw-invoice.pdf",
    ]);
  });
});

test("malformed raw base64url becomes an ordered per-message issue", async () => {
  await withStaging(async (directory) => {
    const client = new FakeGmailClient();
    client.listPages.set("", { messageIds: ["bad-raw"] });
    client.messages.set("bad-raw", gmailMessage({
      id: "bad-raw",
      date: new Date("2026-07-04T10:00:00.000Z"),
      rfcMessageId: "<bad-raw@example.com>",
      payload: {
        partId: "1",
        mimeType: "message/rfc822",
        filename: "forwarded.eml",
        headers: [{ name: "Message-ID", value: "<bad-raw@example.com>" }],
        body: { data: "bmVzdGVk" },
        parts: [],
      },
    }));
    client.raws.set("bad-raw", "not base64url!");

    const result = await source(client).search(searchOptions(directory));

    assert.equal(result.scannedMessages, 1);
    assert.equal(result.attachments.length, 0);
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0]?.messageId, "<bad-raw@example.com>");
    assert.match(result.issues[0]?.message ?? "", /malformed base64url/u);
    assert.deepEqual(await readdir(directory), []);
  });
});

test("metadata requests are bounded and inverted completion does not alter publication order", async () => {
  await withStaging(async (directory) => {
    const client = new FakeGmailClient();
    const ids = Array.from({ length: 14 }, (_, index) => `id-${String(index).padStart(2, "0")}`);
    client.listPages.set("", { messageIds: [...ids].reverse() });
    ids.forEach((id, index) => {
      client.messages.set(id, gmailMessage({
        id,
        date: new Date(start.getTime() + index * 60_000),
        rfcMessageId: `<${id}@example.com>`,
      }));
      client.messageDelay.set(id, (ids.length - index) * 2);
    });
    const gmailSource = new GmailApiMailSource(async () => profile(), {
      clientFactory: () => client,
      requestConcurrency: 3,
      workingChunkSize: 7,
    });

    const result = await gmailSource.search(searchOptions(directory));

    assert.equal(client.maximumActiveMessageGets, 3);
    assert.deepEqual(
      result.attachments.map((attachment) => attachment.originalName),
      ids.map((id) => `${id}.pdf`),
    );
  });
});

test("attachment callback failures drain admitted work and remove unpublished files", async () => {
  await withStaging(async (directory) => {
    const client = new FakeGmailClient();
    client.listPages.set("", { messageIds: ["one", "two", "three"] });
    ["one", "two", "three"].forEach((id, index) => {
      client.messages.set(id, gmailMessage({
        id,
        date: new Date(start.getTime() + index * 60_000),
        rfcMessageId: `<${id}@example.com>`,
      }));
    });
    const consumerError = new Error("consumer stopped");

    await assert.rejects(
      source(client).search({
        ...searchOptions(directory),
        onAttachment: async () => {
          throw consumerError;
        },
      }),
      (error: unknown) => error === consumerError,
    );
    assert.deepEqual(await readdir(directory), []);
  });
});

test("authentication and listing failures are fatal MailSourceErrors", async () => {
  await withStaging(async (directory) => {
    const wrongAccount = new FakeGmailClient();
    wrongAccount.profileEmail = "other@example.com";
    await assert.rejects(
      source(wrongAccount).search(searchOptions(directory)),
      (error: unknown) =>
        error instanceof MailSourceError && error.code === "MAIL_ACCESS_FAILED",
    );

    const listFailure = new FakeGmailClient();
    listFailure.listMessages = async () => {
      throw new Error("quota unavailable");
    };
    await assert.rejects(
      source(listFailure).search(searchOptions(directory)),
      (error: unknown) =>
        error instanceof MailSourceError &&
        error.code === "MAIL_ACCESS_FAILED" &&
        /quota unavailable/u.test(error.message),
    );
  });
});
