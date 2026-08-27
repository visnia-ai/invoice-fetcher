import assert from "node:assert/strict";
import test from "node:test";

import {
  getEligibleAttachmentKind,
  isEligibleAttachment,
  isPdfAttachment,
} from "../src/detection/index.js";

test("recognizes supported filename extensions case-insensitively", () => {
  const cases = {
    pdf: ["x.pdf", "x.PDF"],
    document: [
      "x.doc", "x.docx", "x.docm", "x.xls", "x.xlsx", "x.xlsm", "x.xlsb",
      "x.odt", "x.ods", "x.odp", "x.odg", "x.odf", "x.rtf", "x.txt", "x.xml", "x.csv",
    ],
    image: ["x.jpg", "x.jpeg", "x.png", "x.heic", "x.heif", "x.tif", "x.tiff", "x.webp"],
  } as const;

  for (const [kind, names] of Object.entries(cases)) {
    for (const name of names) assert.equal(getEligibleAttachmentKind(name), kind, name);
  }
});

test("falls back to a supported MIME type for extensionless files", () => {
  assert.equal(getEligibleAttachmentKind("attachment", "application/pdf"), "pdf");
  assert.equal(
    getEligibleAttachmentKind("attachment", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
    "document",
  );
  assert.equal(getEligibleAttachmentKind("attachment", "image/jpeg; name=image"), "image");
});

test("always excludes archives and rejects unrelated formats", () => {
  for (const extension of ["zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz", "cab"]) {
    assert.equal(isEligibleAttachment(`invoice.${extension}`, "application/pdf"), false);
  }
  assert.equal(isEligibleAttachment("invoice.exe"), false);
  assert.equal(isEligibleAttachment("invoice"), false);
});

test("PDF helper accepts only .pdf names or extensionless PDF MIME types", () => {
  assert.equal(isPdfAttachment("statement.pdf"), true);
  assert.equal(isPdfAttachment("statement.PDF", "application/octet-stream"), true);
  assert.equal(isPdfAttachment("statement", "application/pdf"), true);
  assert.equal(isPdfAttachment("statement", "application/pdf; name=statement"), true);
  assert.equal(isPdfAttachment("statement.png", "application/pdf"), false);
  assert.equal(isPdfAttachment("statement.exe", "application/pdf"), false);
  assert.equal(isPdfAttachment("statement", "image/png"), false);
});
