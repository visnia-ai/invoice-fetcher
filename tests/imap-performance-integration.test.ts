import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { text } from "node:stream/consumers";
import test from "node:test";

import {
  ImapMailSource,
  type ImapClient,
  type ImapConnectionProfile,
  type ImapMessageMetadata,
  type MimeExtractor,
} from "../src/imap/index.js";

const start = new Date("2026-07-01T00:00:00.000Z");
const end = new Date("2026-07-11T00:00:00.000Z");

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => { resolve = settle; });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Timed out waiting for asynchronous test state.");
}

function profile(): ImapConnectionProfile {
  return {
    provider: "google",
    email: "billing@example.com",
    host: "imap.gmail.com",
    port: 993,
    tls: "implicit",
    username: "billing@example.com",
    authentication: { type: "oauth2", accessToken: "token" },
  };
}

function metadata(uid: number): ImapMessageMetadata {
  return {
    uid,
    messageId: `<message-${uid}@example.com>`,
    receivedAt: new Date("2026-07-05T12:00:00.000Z"),
    sender: "Vendor <billing@vendor.example>",
    subject: "Documents",
    hasAttachments: true,
  };
}

class ConcurrentClient implements ImapClient {
  currentMailbox = "";
  connected = false;
  loggedOut = false;

  constructor(
    private readonly shared: {
      gates: Map<number, Deferred>;
      active: number;
      maximumActive: number;
      started?: number[];
      releasedLocks?: { count: number };
      metadataForUid?: (uid: number) => ImapMessageMetadata;
      uids?: number[];
    },
    private readonly primary: boolean,
  ) {}

  async connect(): Promise<void> { this.connected = true; }
  async listMailboxes() {
    return [{ path: "[Gmail]/All Mail", delimiter: "/", specialUse: "\\All", selectable: true }];
  }
  async lockMailbox(path: string) {
    this.currentMailbox = path;
    return {
      release: () => {
        if (this.shared.releasedLocks) this.shared.releasedLocks.count += 1;
      },
    };
  }
  async searchReceived() { return this.primary ? (this.shared.uids ?? [1, 2, 3]) : []; }
  async fetchMetadataBatch(uids: readonly number[]) {
    return uids.map((uid) => ({
      kind: "success" as const,
      uid,
      metadata: this.shared.metadataForUid?.(uid) ?? metadata(uid),
    }));
  }
  async downloadMessage(uid: number): Promise<Readable> {
    this.shared.started?.push(uid);
    this.shared.active += 1;
    this.shared.maximumActive = Math.max(this.shared.maximumActive, this.shared.active);
    await this.shared.gates.get(uid)?.promise;
    this.shared.active -= 1;
    return Readable.from(String(uid));
  }
  async downloadPart(): Promise<{ content: Readable }> {
    throw new Error("part plan is not configured");
  }
  async logout(): Promise<void> { this.loggedOut = true; }
}

class TransportClient implements ImapClient {
  loggedOut = false;
  downloadCalls = 0;

  constructor(
    private readonly primary: boolean,
    private readonly failTransport = false,
  ) {}

  async connect(): Promise<void> {}
  async listMailboxes() {
    return [{ path: "[Gmail]/All Mail", delimiter: "/", specialUse: "\\All", selectable: true }];
  }
  async lockMailbox() { return { release: () => undefined }; }
  async searchReceived() { return this.primary ? [1, 2, 3, 4] : []; }
  async fetchMetadataBatch(uids: readonly number[]) {
    return uids.map((uid) => ({ kind: "success" as const, uid, metadata: metadata(uid) }));
  }
  async downloadMessage(uid: number): Promise<Readable> {
    this.downloadCalls += 1;
    if (this.failTransport) {
      throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
    }
    return Readable.from(String(uid));
  }
  async downloadPart(): Promise<{ content: Readable }> {
    throw new Error("part plan is not configured");
  }
  async logout(): Promise<void> { this.loggedOut = true; }
}

const bodyExtractor: MimeExtractor = {
  async extract(request) {
    const uid = await text(request.source);
    return {
      attachments: [{
        attachmentId: `attachment-${uid}`,
        stagedPath: join(request.stagingDirectory, `${uid}.pdf`),
        originalName: `${uid}.pdf`,
        mimeType: "application/pdf",
        size: 1,
      }],
      emailContextMatches: false,
      emailReceiptMatches: false,
      issues: [],
    };
  },
};

test("three IMAP sessions download concurrently and publish in stable UID order", async () => {
  const directory = await mkdtemp(join(tmpdir(), "invoice-fetcher-concurrency-"));
  try {
    const shared = {
      gates: new Map([1, 2, 3].map((uid) => [uid, deferred()])),
      active: 0,
      maximumActive: 0,
    };
    const clients = [
      new ConcurrentClient(shared, true),
      new ConcurrentClient(shared, false),
      new ConcurrentClient(shared, false),
    ];
    let factoryIndex = 0;
    const source = new ImapMailSource(async () => profile(), {
      clientFactory: () => clients[factoryIndex++]!,
      mimeExtractor: bodyExtractor,
      maximumConnections: 3,
    });
    const streamed: string[] = [];
    const running = source.search({
      accountEmail: "billing@example.com",
      startInclusive: start,
      endExclusive: end,
      stagingDirectory: directory,
      keywords: ["invoice"],
      onAttachment: async (attachment) => { streamed.push(attachment.originalName); },
    });

    await waitFor(() => shared.maximumActive === 3);
    assert.equal(shared.maximumActive, 3);
    shared.gates.get(3)?.resolve();
    shared.gates.get(2)?.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(streamed, []);
    shared.gates.get(1)?.resolve();

    const result = await running;
    assert.deepEqual(result.attachments.map((item) => item.originalName), ["1.pdf", "2.pdf", "3.pdf"]);
    assert.deepEqual(streamed, ["1.pdf", "2.pdf", "3.pdf"]);
    assert.ok(clients.every((client) => client.connected && client.loggedOut));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("sliding admission keeps workers busy and bounds callback backpressure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "invoice-fetcher-backpressure-"));
  try {
    const started: number[] = [];
    const uids = Array.from({ length: 12 }, (_, index) => index + 1);
    const shared = {
      gates: new Map(uids.map((uid) => [uid, deferred()])),
      active: 0,
      maximumActive: 0,
      started,
      uids,
    };
    const clients = [
      new ConcurrentClient(shared, true),
      new ConcurrentClient(shared, false),
      new ConcurrentClient(shared, false),
    ];
    let factoryIndex = 0;
    const source = new ImapMailSource(async () => profile(), {
      clientFactory: () => clients[factoryIndex++]!,
      mimeExtractor: bodyExtractor,
      maximumConnections: 3,
    });
    const callbackStarted = deferred();
    const callbackGate = deferred();
    let callbackCount = 0;
    const running = source.search({
      accountEmail: "billing@example.com",
      startInclusive: start,
      endExclusive: end,
      stagingDirectory: directory,
      keywords: ["invoice"],
      onAttachment: async () => {
        callbackCount += 1;
        if (callbackCount === 1) {
          callbackStarted.resolve();
          await callbackGate.promise;
        }
      },
    });

    await waitFor(() => started.length === 3);
    for (const uid of uids.slice(1, 9)) {
      await waitFor(() => started.includes(uid));
      shared.gates.get(uid)?.resolve();
    }
    assert.ok(started.includes(4), "a free worker starts UID 4 before slow UID 1");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(started.length, 9, "six buffered outcomes plus three active tasks are admitted");

    shared.gates.get(1)?.resolve();
    await callbackStarted.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(started.length, 9, "blocked publication applies bounded backpressure");

    callbackGate.resolve();
    await waitFor(() => started.length === 12);
    for (const uid of uids.slice(9)) shared.gates.get(uid)?.resolve();
    const result = await running;
    assert.equal(result.attachments.length, 12);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("callback failure drains active downloads before releasing mailbox locks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "invoice-fetcher-callback-failure-"));
  try {
    const releasedLocks = { count: 0 };
    const shared = {
      gates: new Map([1, 2, 3].map((uid) => [uid, deferred()])),
      active: 0,
      maximumActive: 0,
      releasedLocks,
    };
    const clients = [
      new ConcurrentClient(shared, true),
      new ConcurrentClient(shared, false),
      new ConcurrentClient(shared, false),
    ];
    let factoryIndex = 0;
    const source = new ImapMailSource(async () => profile(), {
      clientFactory: () => clients[factoryIndex++]!,
      mimeExtractor: bodyExtractor,
      maximumConnections: 3,
    });
    const callbackFailure = new Error("consumer failed");
    let settled = false;
    const running = source.search({
      accountEmail: "billing@example.com",
      startInclusive: start,
      endExclusive: end,
      stagingDirectory: directory,
      keywords: ["invoice"],
      onAttachment: async () => { throw callbackFailure; },
    }).finally(() => { settled = true; });

    await waitFor(() => shared.maximumActive === 3);
    shared.gates.get(1)?.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    assert.equal(releasedLocks.count, 1, "only the initial search lock is released");
    shared.gates.get(2)?.resolve();
    shared.gates.get(3)?.resolve();
    await assert.rejects(running, /consumer failed/u);
    assert.equal(shared.active, 0);
    assert.equal(releasedLocks.count, 4);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("three matching Message-IDs are downloaded only once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "invoice-fetcher-triple-dedupe-"));
  try {
    const started: number[] = [];
    const gates = new Map([1, 2, 3].map((uid) => [uid, deferred()]));
    for (const gate of gates.values()) gate.resolve();
    const shared = {
      gates,
      active: 0,
      maximumActive: 0,
      started,
      metadataForUid: (uid: number) => ({
        ...metadata(uid),
        messageId: "<duplicate@example.com>",
      }),
    };
    const clients = [
      new ConcurrentClient(shared, true),
      new ConcurrentClient(shared, false),
      new ConcurrentClient(shared, false),
    ];
    let factoryIndex = 0;
    const source = new ImapMailSource(async () => profile(), {
      clientFactory: () => clients[factoryIndex++]!,
      mimeExtractor: bodyExtractor,
      maximumConnections: 3,
    });
    const result = await source.search({
      accountEmail: "billing@example.com",
      startInclusive: start,
      endExclusive: end,
      stagingDirectory: directory,
      keywords: ["invoice"],
    });

    assert.deepEqual(started, [1]);
    assert.equal(result.attachments.length, 1);
    assert.equal(result.scannedMessages, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a transport-failed worker is replaced once and later work continues", async () => {
  const directory = await mkdtemp(join(tmpdir(), "invoice-fetcher-worker-replacement-"));
  try {
    const primary = new TransportClient(true);
    const healthy = new TransportClient(false);
    const dead = new TransportClient(false, true);
    const replacement = new TransportClient(false);
    const clients = [primary, healthy, dead, replacement];
    let factoryIndex = 0;
    const source = new ImapMailSource(async () => profile(), {
      clientFactory: () => clients[factoryIndex++]!,
      mimeExtractor: bodyExtractor,
      maximumConnections: 3,
    });
    const result = await source.search({
      accountEmail: "billing@example.com",
      startInclusive: start,
      endExclusive: end,
      stagingDirectory: directory,
      keywords: ["invoice"],
    });

    assert.equal(dead.downloadCalls, 1);
    assert.equal(factoryIndex, 4, "exactly one replacement session is created");
    assert.equal(result.scannedMessages, 4);
    assert.equal(result.attachments.length, 3);
    assert.deepEqual(result.issues.map((issue) => issue.code), ["MESSAGE_READ_FAILED"]);
    assert.ok(clients.every((client) => client.loggedOut));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("planned parts avoid full-message download and publish after staging", async () => {
  const directory = await mkdtemp(join(tmpdir(), "invoice-fetcher-parts-source-"));
  try {
    let fullDownloads = 0;
    const partDownloads: string[] = [];
    const client: ImapClient = {
      connect: async () => undefined,
      listMailboxes: async () => [{ path: "INBOX", delimiter: "/", selectable: true }],
      lockMailbox: async () => ({ release: () => undefined }),
      searchReceived: async () => [1],
      fetchMetadataBatch: async () => [{
        kind: "success",
        uid: 1,
        metadata: {
          ...metadata(1),
          partPlan: {
            attachments: [{
              part: "2",
              attachmentId: "invoice-part",
              originalName: "invoice.pdf",
              mimeType: "application/pdf",
              size: 4,
            }],
            contextParts: [{ part: "1", mimeType: "text/plain" }],
          },
        },
      }],
      downloadMessage: async () => {
        fullDownloads += 1;
        return Readable.from("legacy");
      },
      downloadPart: async (_uid, part) => {
        partDownloads.push(part);
        return { content: Readable.from("%PDF") };
      },
      logout: async () => undefined,
    };
    const source = new ImapMailSource(async () => ({ ...profile(), provider: "imap", authentication: { type: "password", password: "secret" } }), {
      clientFactory: () => client,
      mimeExtractor: { extract: async () => { throw new Error("legacy extraction must not run"); } },
      maximumConnections: 1,
    });
    const eventOrder: string[] = [];
    const callbackStarted = deferred();
    const callbackGate = deferred();
    let settled = false;
    const running = source.search({
      accountEmail: "billing@example.com",
      startInclusive: start,
      endExclusive: end,
      stagingDirectory: directory,
      keywords: ["invoice"],
      onProgress: (event) => {
        if (event.type === "attachment-staged") eventOrder.push("event");
      },
      onAttachment: async () => {
        eventOrder.push("callback");
        callbackStarted.resolve();
        await callbackGate.promise;
      },
    }).finally(() => { settled = true; });
    await callbackStarted.promise;
    assert.equal(settled, false);
    callbackGate.resolve();
    const result = await running;

    assert.deepEqual(partDownloads, ["2"]);
    assert.equal(fullDownloads, 0);
    assert.deepEqual(eventOrder, ["event", "callback"]);
    assert.equal(result.attachments[0]?.originalName, "invoice.pdf");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("part failures clean up and transparently use the legacy extractor", async () => {
  const directory = await mkdtemp(join(tmpdir(), "invoice-fetcher-parts-fallback-"));
  try {
    let fullDownloads = 0;
    const client: ImapClient = {
      connect: async () => undefined,
      listMailboxes: async () => [{ path: "INBOX", delimiter: "/", selectable: true }],
      lockMailbox: async () => ({ release: () => undefined }),
      searchReceived: async () => [1],
      fetchMetadataBatch: async () => [{
        kind: "success",
        uid: 1,
        metadata: {
          ...metadata(1),
          partPlan: {
            attachments: [{
              part: "2",
              attachmentId: "invoice-part",
              originalName: "invoice.pdf",
              mimeType: "application/pdf",
              size: null,
            }],
            contextParts: [],
          },
        },
      }],
      downloadPart: async () => { throw new Error("part unavailable"); },
      downloadMessage: async () => {
        fullDownloads += 1;
        return Readable.from("legacy");
      },
      logout: async () => undefined,
    };
    const source = new ImapMailSource(async () => ({ ...profile(), provider: "imap", authentication: { type: "password", password: "secret" } }), {
      clientFactory: () => client,
      mimeExtractor: bodyExtractor,
      maximumConnections: 1,
    });
    const result = await source.search({
      accountEmail: "billing@example.com",
      startInclusive: start,
      endExclusive: end,
      stagingDirectory: directory,
      keywords: ["invoice"],
    });

    assert.equal(fullDownloads, 1);
    assert.equal(result.attachments.length, 1);
    assert.equal(result.issues.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
