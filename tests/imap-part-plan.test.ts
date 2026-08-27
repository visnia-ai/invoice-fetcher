import assert from "node:assert/strict";
import test from "node:test";

import { buildImapMessagePartPlan } from "../src/imap/index.js";

test("part plan separates alternative message context from attachments", () => {
  const plan = buildImapMessagePartPlan({
    type: "multipart/mixed",
    childNodes: [
      {
        part: "1",
        type: "multipart/alternative",
        childNodes: [
          { part: "1.1", type: "text/plain", size: 100 },
          { part: "1.2", type: "text/html", size: 200 },
        ],
      },
      {
        part: "2",
        type: "application/pdf",
        disposition: "attachment",
        dispositionParameters: { filename: "invoice.pdf" },
        id: "<invoice-part>",
        size: 1234,
      },
    ],
  });

  assert.deepEqual(plan, {
    attachments: [
      {
        part: "2",
        attachmentId: "<invoice-part>",
        originalName: "invoice.pdf",
        mimeType: "application/pdf",
        size: 1234,
      },
    ],
    contextParts: [
      { part: "1.1", mimeType: "text/plain" },
      { part: "1.2", mimeType: "text/html" },
    ],
  });
});

test("ordinary text bodies are context, while named text parts are excluded", () => {
  const plan = buildImapMessagePartPlan({
    type: "multipart/mixed",
    childNodes: [
      { part: "1", type: "text/plain" },
      {
        part: "2",
        type: "text/plain",
        disposition: "inline",
        parameters: { NAME: "details.txt" },
      },
    ],
  });

  assert.deepEqual(plan?.contextParts, [{ part: "1", mimeType: "text/plain" }]);
  assert.deepEqual(plan?.attachments, []);
});

test("part plan excludes non-PDF binary parts and keeps extensionless PDFs", () => {
  const plan = buildImapMessagePartPlan({
    type: "multipart/mixed",
    childNodes: [
      {
        part: "1",
        type: "application/zip",
        disposition: "attachment",
        dispositionParameters: { filename: "bundle.zip" },
      },
      {
        part: "2",
        type: "image/png",
        disposition: "attachment",
        dispositionParameters: { filename: "invoice.png" },
        size: -1,
      },
      { part: "3", type: "application/pdf", disposition: "attachment" },
    ],
  });

  assert.deepEqual(plan?.attachments, [
    {
      part: "3",
      attachmentId: "3:attachment-3",
      originalName: "attachment-3",
      mimeType: "application/pdf",
      size: null,
    },
  ]);
});

test("part plan normalizes unsafe filenames and supports single-part roots", () => {
  const plan = buildImapMessagePartPlan({
    type: "application/pdf",
    disposition: "attachment",
    dispositionParameters: { filename: "../folder\\July.pdf" },
  });

  assert.deepEqual(plan?.attachments[0], {
    part: "1",
    attachmentId: "1:July.pdf",
    originalName: "July.pdf",
    mimeType: "application/pdf",
    size: null,
  });
});

test("part plan rejects malformed, mismatched, and nested-message structures", () => {
  assert.equal(buildImapMessagePartPlan(undefined), undefined);
  assert.equal(buildImapMessagePartPlan({ type: "multipart/mixed", childNodes: [] }), undefined);
  assert.equal(
    buildImapMessagePartPlan({
      type: "multipart/mixed",
      childNodes: [{ part: "9", type: "application/pdf" }],
    }),
    undefined,
  );
  assert.equal(
    buildImapMessagePartPlan({
      type: "multipart/mixed",
      childNodes: [{ part: "1", type: "message/rfc822", childNodes: [] }],
    }),
    undefined,
  );
});
