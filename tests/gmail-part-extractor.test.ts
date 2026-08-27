import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { extractGmailMessageParts } from "../src/gmail/part-extractor.js";
import type {
  GmailApiClient,
  GmailMessagePartPlan,
} from "../src/gmail/types.js";

const keywords = ["invoice", "receipt", "facture", "bill", "发票"];

function encoded(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function clientFor(
  attachments: Readonly<Record<string, string>>,
  requested: string[],
): GmailApiClient {
  return {
    getAttachment: async (messageId, attachmentId) => {
      requested.push(`${messageId}:${attachmentId}`);
      const data = attachments[attachmentId];
      if (data === undefined) throw new Error(`missing attachment ${attachmentId}`);
      return { data };
    },
  } as GmailApiClient;
}

function pdfPlan(originalName = "details.pdf"): GmailMessagePartPlan {
  return {
    attachments: [
      {
        partId: "2",
        attachmentId: "2:details.pdf",
        originalName,
        mimeType: "application/pdf",
        size: 999,
        externalAttachmentId: "remote-2",
      },
    ],
    contextParts: [
      { partId: "1", mimeType: "text/plain", inlineData: encoded("Votre facture") },
    ],
  };
}

test("Gmail extraction stages external PDFs while checking inline receipt context", async () => {
  const directory = await mkdtemp(join(tmpdir(), "invoice-fetcher-gmail-parts-"));
  try {
    const requested: string[] = [];
    const result = await extractGmailMessageParts({
      client: clientFor({ "remote-2": encoded("attachment") }, requested),
      messageId: "m42",
      partPlan: pdfPlan(),
      stagingDirectory: directory,
      subject: "Documents",
      keywords,
    });

    assert.equal(result.kind, "success");
    if (result.kind !== "success") return;
    assert.deepEqual(requested, ["m42:remote-2"]);
    assert.equal(result.emailContextMatches, false);
    assert.equal(result.emailReceiptMatches, false);
    assert.equal(result.attachments[0]?.size, 10);
    assert.equal(await readFile(result.attachments[0]?.stagedPath ?? "", "utf8"), "attachment");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("subject and built-in filename matches skip context retrieval", async () => {
  const directory = await mkdtemp(join(tmpdir(), "invoice-fetcher-gmail-parts-"));
  try {
    for (const input of [
      { subject: "July receipt", plan: pdfPlan(), expected: true },
      { subject: "Documents", plan: pdfPlan("receipt.pdf"), expected: false },
    ]) {
      const requested: string[] = [];
      input.plan.contextParts = [
        {
          partId: "1",
          mimeType: "text/plain",
          externalAttachmentId: "context",
        },
      ];
      const result = await extractGmailMessageParts({
        client: clientFor({ "remote-2": encoded("attachment") }, requested),
        messageId: "m1",
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
      assert.deepEqual(requested, ["m1:remote-2"]);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("custom keywords do not trigger PDF-irrelevant context retrieval", async () => {
  const directory = await mkdtemp(join(tmpdir(), "invoice-fetcher-gmail-parts-"));
  try {
    const requested: string[] = [];
    const result = await extractGmailMessageParts({
      client: clientFor({ "remote-2": encoded("attachment") }, requested),
      messageId: "m1",
      partPlan: {
        ...pdfPlan("purchase order.pdf"),
        contextParts: [
          {
            partId: "1",
            mimeType: "text/plain",
            inlineData: encoded("purchase order"),
          },
        ],
      },
      stagingDirectory: directory,
      subject: "Documents",
      keywords: ["purchase order"],
    });
    assert.equal(result.kind, "success");
    if (result.kind === "success") {
      assert.equal(result.emailContextMatches, false);
      assert.equal(result.emailReceiptMatches, false);
    }
    assert.deepEqual(requested, ["m1:remote-2"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Gmail extraction ignores non-PDF plans without downloading them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "invoice-fetcher-gmail-parts-"));
  try {
    const requested: string[] = [];
    const result = await extractGmailMessageParts({
      client: clientFor({ file: encoded("not a PDF") }, requested),
      messageId: "m1",
      partPlan: {
        attachments: [{
          partId: "2",
          attachmentId: "image",
          originalName: "invoice.png",
          mimeType: "application/pdf",
          size: null,
          externalAttachmentId: "file",
        }],
        contextParts: [{
          partId: "1",
          mimeType: "text/plain",
          externalAttachmentId: "context",
        }],
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

test("Gmail extraction preserves legacy attachment-ID ordering", async () => {
  const directory = await mkdtemp(join(tmpdir(), "invoice-fetcher-gmail-parts-"));
  try {
    const result = await extractGmailMessageParts({
      client: clientFor({}, []),
      messageId: "m1",
      partPlan: {
        attachments: [
          { partId: "1", attachmentId: "zeta", originalName: "z.pdf", mimeType: "application/pdf", size: null, inlineData: encoded("z") },
          { partId: "2", attachmentId: "alpha", originalName: "a.pdf", mimeType: "application/pdf", size: null, inlineData: encoded("a") },
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
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Gmail PDF extraction decodes charset and flowed receipt context", async () => {
  const directory = await mkdtemp(join(tmpdir(), "invoice-fetcher-gmail-parts-"));
  try {
    const context = Buffer.from("Votre re \r\nceipt est prête", "latin1");
    const result = await extractGmailMessageParts({
      client: clientFor({ "remote-2": encoded("attachment") }, []),
      messageId: "m1",
      partPlan: {
        ...pdfPlan(),
        contextParts: [
          {
            partId: "1",
            mimeType: "text/plain",
            inlineData: encoded(context),
            charset: "iso-8859-1",
            flowed: true,
            delSp: true,
          },
        ],
      },
      stagingDirectory: directory,
      subject: "Documents",
      keywords,
    });
    assert.equal(result.kind, "success");
    if (result.kind === "success") {
      assert.equal(result.emailContextMatches, false);
      assert.equal(result.emailReceiptMatches, true);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Gmail receipt-context failures fall back and clean staged PDFs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "invoice-fetcher-gmail-parts-"));
  try {
    const result = await extractGmailMessageParts({
      client: clientFor({ "remote-2": encoded("attachment") }, []),
      messageId: "m1",
      partPlan: {
        ...pdfPlan(),
        contextParts: [{
          partId: "1",
          mimeType: "text/plain",
          externalAttachmentId: "missing-context",
        }],
      },
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

test("invalid base64url and attachment failures clean every partial file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "invoice-fetcher-gmail-parts-"));
  try {
    for (const plan of [
      {
        attachments: [
          { partId: "1", attachmentId: "first", originalName: "first.pdf", mimeType: "application/pdf", size: null, inlineData: encoded("first") },
          { partId: "2", attachmentId: "second", originalName: "second.pdf", mimeType: "application/pdf", size: null, inlineData: "invalid+data" },
        ],
        contextParts: [],
      },
      {
        attachments: [
          { partId: "1", attachmentId: "first", originalName: "first.pdf", mimeType: "application/pdf", size: null, inlineData: encoded("first") },
          { partId: "2", attachmentId: "second", originalName: "second.pdf", mimeType: "application/pdf", size: null, externalAttachmentId: "missing" },
        ],
        contextParts: [],
      },
    ] satisfies GmailMessagePartPlan[]) {
      const result = await extractGmailMessageParts({
        client: clientFor({}, []),
        messageId: "m1",
        partPlan: plan,
        stagingDirectory: directory,
        subject: "invoice",
        keywords,
      });
      assert.equal(result.kind, "fallback");
      if (result.kind === "fallback") assert.equal(result.stagedPaths.length, 2);
      assert.deepEqual(await readdir(directory), []);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("missing content and invalid part identifiers request raw fallback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "invoice-fetcher-gmail-parts-"));
  try {
    for (const attachment of [
      { partId: "bad/id", attachmentId: "bad", originalName: "bad.pdf", mimeType: "application/pdf", size: null },
      { partId: "1", attachmentId: "missing", originalName: "missing.pdf", mimeType: "application/pdf", size: null },
    ]) {
      const result = await extractGmailMessageParts({
        client: clientFor({}, []),
        messageId: "m1",
        partPlan: { attachments: [attachment], contextParts: [] },
        stagingDirectory: directory,
        subject: "invoice",
        keywords,
      });
      assert.equal(result.kind, "fallback");
      assert.deepEqual(await readdir(directory), []);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
