import assert from "node:assert/strict";
import test from "node:test";

import { classifyAttachment, type PdfTextExtraction } from "../src/detection/index.js";

const extraction = (text: string): PdfTextExtraction => ({
  text,
  pageCount: 1,
  hasText: text.trim().length > 0,
});

test("rejects unsupported attachments before classification", async () => {
  const result = await classifyAttachment({
    originalName: "invoice.zip",
    stagedPath: "/unused",
    emailContextMatches: true,
    emailReceiptMatches: true,
  });
  assert.deepEqual(result, { include: false, reason: "unsupported-type", partialFailure: false });
});

test("includes eligible filename keyword matches without parsing", async () => {
  let parsed = false;
  const result = await classifyAttachment(
    { originalName: "Receipt 2026.PDF", stagedPath: "/unused", emailContextMatches: false, emailReceiptMatches: false },
    {
      extractPdfText: async () => { parsed = true; return extraction(""); },
    },
  );
  assert.equal(result.reason, "filename-keyword");
  assert.equal(result.include, true);
  assert.equal(parsed, false);
});

test("includes PDFs whose extracted text matches on any page", async () => {
  const result = await classifyAttachment(
    { originalName: "document.pdf", stagedPath: "/staged/document.pdf", emailContextMatches: false, emailReceiptMatches: false },
    { extractPdfText: async (path) => {
      assert.equal(path, "/staged/document.pdf");
      return extraction("Page one\nPurchase receipt 2026");
    } },
  );
  assert.deepEqual(result, { include: true, reason: "pdf-text-keyword", partialFailure: false });
});

test("includes textless PDFs conservatively", async () => {
  const result = await classifyAttachment(
    { originalName: "scan.pdf", stagedPath: "/unused", emailContextMatches: false, emailReceiptMatches: false },
    { extractPdfText: async () => extraction("  \n") },
  );
  assert.deepEqual(result, { include: true, reason: "pdf-textless", partialFailure: false });
});

test("rejects readable PDFs with no invoice signal even when email context matches", async () => {
  const result = await classifyAttachment(
    { originalName: "brochure.pdf", stagedPath: "/unused", emailContextMatches: true, emailReceiptMatches: false },
    { extractPdfText: async () => extraction("A regular product brochure") },
  );
  assert.deepEqual(result, { include: false, reason: "no-invoice-signal", partialFailure: false });
});

test("includes unreadable or encrypted PDFs with warning and partial failure", async () => {
  const result = await classifyAttachment(
    { originalName: "protected.pdf", stagedPath: "/unused", emailContextMatches: false, emailReceiptMatches: false },
    { extractPdfText: async () => { throw new Error("PasswordException"); } },
  );
  assert.equal(result.include, true);
  assert.equal(result.reason, "pdf-unreadable");
  assert.equal(result.partialFailure, true);
  assert.match(result.warning ?? "", /included conservatively/i);
  assert.doesNotMatch(result.warning ?? "", /PasswordException/);
});

test("rejects non-PDFs before filename or email-context classification", async () => {
  for (const originalName of ["invoice.docx", "invoice.xlsx", "invoice.jpeg", "invoice.txt"]) {
    const result = await classifyAttachment(
      {
        originalName,
        stagedPath: "/unused",
        mimeType: "application/pdf",
        emailContextMatches: true,
        emailReceiptMatches: true,
      },
    );
    assert.deepEqual(result, {
      include: false,
      reason: "unsupported-type",
      partialFailure: false,
    });
  }
});

test("includes PDFs immediately when receipt appears in email context", async () => {
  let parsed = false;
  const result = await classifyAttachment(
    {
      originalName: "purchase.pdf",
      stagedPath: "/unused",
      emailContextMatches: true,
      emailReceiptMatches: true,
    },
    {
      extractPdfText: async () => {
        parsed = true;
        return extraction("ordinary content");
      },
    },
  );
  assert.equal(parsed, false);
  assert.deepEqual(result, {
    include: true,
    reason: "email-context-keyword",
    partialFailure: false,
  });
});
