import assert from "node:assert/strict";
import { readdir, readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { text } from "node:stream/consumers";
import test from "node:test";

import {
  extractPlannedMessageParts,
  ImapFlowClientAdapter,
  matchesMessageKeyword,
  type ImapClient,
  type ImapMessagePartPlan,
} from "../src/imap/index.js";

const keywords = ["invoice", "receipt", "facture", "bill", "发票"];

function clientFor(
  parts: Readonly<Record<string, string | (() => Readable)>>,
  requested: string[],
): ImapClient {
  return {
    downloadPart: async (_uid, part) => {
      requested.push(part);
      const value = parts[part];
      if (value === undefined) throw new Error(`missing part ${part}`);
      return { content: typeof value === "function" ? value() : Readable.from(value) };
    },
  } as ImapClient;
}

function pdfPlan(originalName = "details.pdf"): ImapMessagePartPlan {
  return {
    attachments: [
      {
        part: "2",
        attachmentId: "2:details.pdf",
        originalName,
        mimeType: "application/pdf",
        size: 999,
      },
    ],
    contextParts: [{ part: "1", mimeType: "text/plain" }],
  };
}

test("planned extraction stages PDFs and checks body receipt context", async () => {
  const directory = await mkdtemp(join(tmpdir(), "invoice-fetcher-parts-"));
  try {
    const requested: string[] = [];
    const result = await extractPlannedMessageParts({
      client: clientFor({ "1": "Votre receipt est prêt.", "2": "attachment" }, requested),
      uid: 42,
      partPlan: pdfPlan(),
      stagingDirectory: directory,
      subject: "Documents",
      keywords,
    });

    assert.equal(result.kind, "success");
    if (result.kind !== "success") return;
    assert.deepEqual(requested, ["2", "1"]);
    assert.equal(result.emailContextMatches, false);
    assert.equal(result.emailReceiptMatches, true);
    assert.equal(result.attachments.length, 1);
    assert.equal(result.attachments[0]?.size, 10);
    assert.match(
      result.attachments[0]?.stagedPath ?? "",
      /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-details\.pdf$/u,
    );
    assert.equal(await readFile(result.attachments[0]?.stagedPath ?? "", "utf8"), "attachment");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("subject and filename matches avoid unnecessary context downloads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "invoice-fetcher-parts-"));
  try {
    for (const input of [
      { subject: "July receipt", plan: pdfPlan(), expected: true },
      { subject: "Documents", plan: pdfPlan("receipt.pdf"), expected: false },
    ]) {
      const requested: string[] = [];
      const result = await extractPlannedMessageParts({
        client: clientFor({ "1": "facture", "2": "attachment" }, requested),
        uid: 1,
        partPlan: input.plan,
        stagingDirectory: directory,
        subject: input.subject,
        keywords,
      });
      assert.equal(result.kind, "success");
      if (result.kind === "success") {
        assert.equal(result.emailContextMatches, input.expected);
        assert.equal(result.emailReceiptMatches, input.expected);
      }
      assert.deepEqual(requested, ["2"]);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("receipt scanning remains independent from custom keyword context", async () => {
  const directory = await mkdtemp(join(tmpdir(), "invoice-fetcher-parts-"));
  try {
    const requested: string[] = [];
    const result = await extractPlannedMessageParts({
      client: clientFor({ "1": "purchase order", "2": "attachment" }, requested),
      uid: 1,
      partPlan: pdfPlan("purchase order.pdf"),
      stagingDirectory: directory,
      subject: "Documents",
      keywords: ["purchase order"],
    });
    assert.equal(result.kind, "success");
    if (result.kind === "success") {
      assert.equal(result.emailContextMatches, false);
      assert.equal(result.emailReceiptMatches, false);
    }
    assert.deepEqual(requested, ["2", "1"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("planned extraction ignores non-PDF parts without downloading them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "invoice-fetcher-parts-"));
  try {
    const requested: string[] = [];
    const result = await extractPlannedMessageParts({
      client: clientFor({ "1": "invoice", "2": "not a PDF" }, requested),
      uid: 1,
      partPlan: {
        attachments: [{
          part: "2",
          attachmentId: "image",
          originalName: "invoice.png",
          mimeType: "application/pdf",
          size: null,
        }],
        contextParts: [{ part: "1", mimeType: "text/plain" }],
      },
      stagingDirectory: directory,
      subject: "Documents",
      keywords,
    });

    assert.equal(result.kind, "success");
    if (result.kind === "success") {
      assert.deepEqual(result.attachments, []);
      assert.equal(result.emailContextMatches, false);
      assert.equal(result.emailReceiptMatches, false);
    }
    assert.deepEqual(requested, []);
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("planned attachments retain the legacy attachment-ID ordering", async () => {
  const directory = await mkdtemp(join(tmpdir(), "invoice-fetcher-parts-"));
  try {
    const requested: string[] = [];
    const result = await extractPlannedMessageParts({
      client: clientFor({ "2": "second", "3": "first" }, requested),
      uid: 1,
      partPlan: {
        attachments: [
          { part: "2", attachmentId: "zeta", originalName: "z.pdf", mimeType: "application/pdf", size: null },
          { part: "3", attachmentId: "alpha", originalName: "a.pdf", mimeType: "application/pdf", size: null },
        ],
        contextParts: [],
      },
      stagingDirectory: directory,
      subject: "invoice",
      keywords,
    });
    assert.equal(result.kind, "success");
    if (result.kind === "success") {
      assert.deepEqual(result.attachments.map((item) => item.attachmentId), ["alpha", "zeta"]);
    }
    assert.deepEqual(requested, ["2", "3"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("PDF plans inspect message context for receipt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "invoice-fetcher-parts-"));
  try {
    const requested: string[] = [];
    const result = await extractPlannedMessageParts({
      client: clientFor({ "1": "facture", "2": "%PDF" }, requested),
      uid: 1,
      partPlan: {
        attachments: [
          {
            part: "2",
            attachmentId: "2:file.pdf",
            originalName: "file.pdf",
            mimeType: "application/pdf",
            size: 4,
          },
        ],
        contextParts: [{ part: "1", mimeType: "text/plain" }],
      },
      stagingDirectory: directory,
      subject: "Documents",
      keywords,
    });
    assert.equal(result.kind, "success");
    assert.deepEqual(requested, ["2", "1"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("receipt-context stream failures fall back and clean staged PDFs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "invoice-fetcher-parts-"));
  try {
    const result = await extractPlannedMessageParts({
      client: clientFor(
        {
          "1": () => Readable.from((async function* () {
            yield "partial";
            throw new Error("context transfer failed");
          })()),
          "2": "attachment",
        },
        [],
      ),
      uid: 1,
      partPlan: pdfPlan(),
      stagingDirectory: directory,
      subject: "Documents",
      keywords,
    });
    assert.equal(result.kind, "fallback");
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("part stream failures signal fallback and remove partial staging files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "invoice-fetcher-parts-"));
  try {
    const requested: string[] = [];
    const result = await extractPlannedMessageParts({
      client: clientFor(
        {
          "2": "first",
          "3": () =>
            Readable.from(
              (async function* () {
                yield "partial";
                throw new Error("transfer failed");
              })(),
            ),
        },
        requested,
      ),
      uid: 1,
      partPlan: {
        attachments: [
          {
            part: "2",
            attachmentId: "first",
            originalName: "first.pdf",
            mimeType: "application/pdf",
            size: null,
          },
          {
            part: "3",
            attachmentId: "second",
            originalName: "second.pdf",
            mimeType: "application/pdf",
            size: null,
          },
        ],
        contextParts: [],
      },
      stagingDirectory: directory,
      subject: "invoice",
      keywords,
    });

    assert.equal(result.kind, "fallback");
    if (result.kind === "fallback") {
      assert.match(result.reason, /transfer failed/u);
      assert.equal(result.stagedPaths.length, 2);
    }
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("partial and full-message keyword matching semantics stay equivalent", () => {
  assert.equal(matchesMessageKeyword("billing address", ["bill"]), false);
  assert.equal(matchesMessageKeyword("Please pay this BILL.", ["bill"]), true);
  assert.equal(matchesMessageKeyword("电子发票已开具", ["发票"]), true);
  assert.equal(matchesMessageKeyword("FACTURE n° 2", ["facture"]), true);
});

test("ImapFlow adapter forwards validated part downloads and metadata", async () => {
  const calls: Array<{ uid: number; parts: string[]; options: { uid: true } }> = [];
  const adapter = new ImapFlowClientAdapter({
    downloadMany: async (uid: number, parts: string[], options: { uid: true }) => {
      calls.push({ uid, parts, options });
      return {
        "1.2": {
          content: Buffer.from("bytes"),
          meta: { contentType: "application/pdf", filename: "invoice.pdf" },
        },
      };
    },
  } as never);

  const downloaded = await adapter.downloadPart(9, "1.2");
  assert.deepEqual(calls, [{ uid: 9, parts: ["1.2"], options: { uid: true } }]);
  assert.equal(await text(downloaded.content), "bytes");
  assert.equal(downloaded.mimeType, "application/pdf");
  assert.equal(downloaded.filename, "invoice.pdf");
  await assert.rejects(() => adapter.downloadPart(9, "../bad"), /Invalid IMAP/u);
});

test("ImapFlow adapter preserves text charset and format=flowed decoding", async () => {
  const adapter = new ImapFlowClientAdapter({
    downloadMany: async () => ({
      "1": {
        content: Buffer.from("Votre fac \r\nture est pr\u00eate", "latin1"),
        meta: {
          contentType: "text/plain",
          charset: "iso-8859-1",
          flowed: true,
          delSp: true,
        },
      },
    }),
  } as never);

  const downloaded = await adapter.downloadPart(11, "1");
  assert.equal(await text(downloaded.content), "Votre facture est pr\u00eate");
});

test("ImapFlow adapter preserves named text attachment bytes", async () => {
  const original = Buffer.from([0x63, 0x61, 0x66, 0xe9]);
  const adapter = new ImapFlowClientAdapter({
    downloadMany: async () => ({
      "2": {
        content: original,
        meta: {
          contentType: "text/plain",
          charset: "iso-8859-1",
          filename: "notes.txt",
        },
      },
    }),
  } as never);

  const downloaded = await adapter.downloadPart(12, "2");
  const chunks: Buffer[] = [];
  for await (const chunk of downloaded.content) chunks.push(Buffer.from(chunk));
  assert.deepEqual(Buffer.concat(chunks), original);
});

test("ImapFlow adapter rejects missing selected-part responses", async () => {
  const adapter = new ImapFlowClientAdapter({ downloadMany: async () => ({}) } as never);
  await assert.rejects(
    () => adapter.downloadPart(3, "2"),
    /did not return BODYSTRUCTURE part 2/u,
  );
});

test("ImapFlow metadata includes a normalized part plan", async () => {
  const adapter = new ImapFlowClientAdapter({
    fetchAll: async () => [
      {
        uid: 7,
        internalDate: new Date("2026-07-02T10:00:00Z"),
        envelope: { subject: "Documents", messageId: "<m7>" },
        bodyStructure: {
          type: "multipart/mixed",
          childNodes: [
            { part: "1", type: "text/plain" },
            {
              part: "2",
              type: "application/pdf",
              disposition: "attachment",
              dispositionParameters: { filename: "invoice.pdf" },
            },
          ],
        },
      },
    ],
  } as never);

  const [result] = await adapter.fetchMetadataBatch([7]);
  assert.equal(result?.kind, "success");
  if (result?.kind !== "success") return;
  assert.equal(result.metadata.hasAttachments, true);
  assert.deepEqual(result.metadata.partPlan?.contextParts, [
    { part: "1", mimeType: "text/plain" },
  ]);
  assert.equal(result.metadata.partPlan?.attachments[0]?.part, "2");
});

test("ImapFlow metadata does not flag malformed non-PDF structures as candidates", async () => {
  const adapter = new ImapFlowClientAdapter({
    fetchAll: async () => [
      {
        uid: 8,
        internalDate: new Date("2026-07-02T10:00:00Z"),
        envelope: { subject: "Invoice", messageId: "<m8>" },
        bodyStructure: {
          type: "multipart/mixed",
          childNodes: [{
            part: "bad/id",
            type: "application/pdf",
            disposition: "attachment",
            dispositionParameters: { filename: "invoice.png" },
          }],
        },
      },
    ],
  } as never);

  const [result] = await adapter.fetchMetadataBatch([8]);
  assert.equal(result?.kind, "success");
  if (result?.kind !== "success") return;
  assert.equal(result.metadata.hasAttachments, false);
  assert.equal(result.metadata.partPlan, undefined);
});
