import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { StreamingMailParserExtractor } from "../src/imap/index.js";

test("streaming MIME extraction stages eligible files and does not persist message bodies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "invoice-fetcher-mime-test-"));
  try {
    const boundary = "invoice-boundary";
    const raw = [
      "From: accounts@vendor.example",
      "To: billing@example.com",
      "Subject: Documents",
      "MIME-Version: 1.0",
      `Content-Type: multipart/mixed; boundary=${boundary}`,
      "",
      `--${boundary}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Votre facture est disponible.",
      `--${boundary}`,
      "Content-Type: application/pdf",
      'Content-Disposition: attachment; filename="../April invoice.pdf"',
      "Content-Transfer-Encoding: base64",
      "Content-ID: <pdf-part>",
      "",
      Buffer.from("fake pdf bytes").toString("base64"),
      `--${boundary}`,
      "Content-Type: application/pdf",
      'Content-Disposition: attachment; filename="invoice.png"',
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from("misleading image").toString("base64"),
      `--${boundary}`,
      "Content-Type: text/plain",
      'Content-Disposition: attachment; filename="invoice.txt"',
      "",
      "invoice text",
      `--${boundary}`,
      "Content-Type: application/zip",
      'Content-Disposition: attachment; filename="invoices.zip"',
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from("archive").toString("base64"),
      `--${boundary}--`,
      "",
    ].join("\r\n");

    const extractor = new StreamingMailParserExtractor();
    const result = await extractor.extract({
      source: Readable.from(raw),
      stagingDirectory: directory,
      subject: "Documents",
      keywords: ["invoice", "facture", "bill", "发票"],
    });

    assert.equal(result.emailContextMatches, true);
    assert.equal(result.emailReceiptMatches, false);
    assert.equal(result.issues.length, 0);
    assert.equal(result.attachments.length, 1);
    assert.equal(result.attachments[0]?.originalName, "April invoice.pdf");
    assert.equal(result.attachments[0]?.attachmentId, "<pdf-part>");
    assert.equal(
      (await readFile(result.attachments[0]?.stagedPath ?? "", "utf8")),
      "fake pdf bytes",
    );
    assert.ok(result.attachments[0]?.stagedPath.startsWith(directory));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("streaming MIME context matching keeps whole-word boundaries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "invoice-fetcher-mime-test-"));
  try {
    const raw = [
      "Content-Type: text/plain; charset=utf-8",
      "",
      "The billing address changed.",
      "",
    ].join("\r\n");
    const result = await new StreamingMailParserExtractor().extract({
      source: Readable.from(raw),
      stagingDirectory: directory,
      subject: "Billing update",
      keywords: ["bill"],
    });
    assert.equal(result.emailContextMatches, false);
    assert.equal(result.emailReceiptMatches, false);
    assert.deepEqual(result.attachments, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("streaming MIME extraction detects receipt in HTML for every PDF", async () => {
  const directory = await mkdtemp(join(tmpdir(), "invoice-fetcher-mime-test-"));
  try {
    const boundary = "receipt-boundary";
    const raw = [
      "Subject: Documents",
      "MIME-Version: 1.0",
      `Content-Type: multipart/mixed; boundary=${boundary}`,
      "",
      `--${boundary}`,
      "Content-Type: text/html; charset=utf-8",
      "",
      "<p>Your purchase receipt is attached.</p>",
      `--${boundary}`,
      "Content-Type: application/pdf",
      'Content-Disposition: attachment; filename="first.pdf"',
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from("first").toString("base64"),
      `--${boundary}`,
      "Content-Type: application/pdf",
      'Content-Disposition: attachment; filename="second.pdf"',
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from("second").toString("base64"),
      `--${boundary}--`,
      "",
    ].join("\r\n");
    const result = await new StreamingMailParserExtractor().extract({
      source: Readable.from(raw),
      stagingDirectory: directory,
      subject: "Documents",
      keywords: ["invoice", "receipt"],
    });
    assert.equal(result.emailReceiptMatches, true);
    assert.equal(result.attachments.length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
