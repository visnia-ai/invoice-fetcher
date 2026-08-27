import assert from "node:assert/strict";
import test from "node:test";

import { buildGmailMessagePartPlan } from "../src/gmail/part-plan.js";

function leaf(
  partId: string,
  mimeType: string,
  options: {
    filename?: string;
    headers?: readonly { name: string; value: string }[];
    data?: string;
    attachmentId?: string;
    size?: number;
  } = {},
) {
  return {
    partId,
    mimeType,
    filename: options.filename ?? "",
    headers: options.headers ?? [],
    body: {
      ...(options.data !== undefined ? { data: options.data } : {}),
      ...(options.attachmentId ? { attachmentId: options.attachmentId } : {}),
      ...(options.size !== undefined ? { size: options.size } : {}),
    },
    parts: [],
  };
}

test("Gmail plan separates alternative context from an external attachment", () => {
  const plan = buildGmailMessagePartPlan({
    partId: "",
    mimeType: "multipart/mixed",
    filename: "",
    headers: [],
    body: { size: 0 },
    parts: [
      {
        partId: "0",
        mimeType: "multipart/alternative",
        filename: "",
        headers: [],
        body: { size: 0 },
        parts: [
          leaf("0.0", "text/plain", {
            data: "aW52b2ljZQ",
            headers: [
              {
                name: "Content-Type",
                value: 'text/plain; charset="iso-8859-1"; format=flowed; delsp=yes',
              },
            ],
          }),
          leaf("0.1", "text/html", { data: "PGI-aW52b2ljZTwvYj4" }),
        ],
      },
      leaf("1", "application/pdf", {
        filename: "invoice.pdf",
        attachmentId: "remote-2",
        size: 1234,
        headers: [
          { name: "Content-Disposition", value: "attachment" },
          { name: "Content-ID", value: "<invoice-part>" },
        ],
      }),
    ],
  });

  assert.deepEqual(plan, {
    attachments: [
      {
        partId: "1",
        attachmentId: "<invoice-part>",
        originalName: "invoice.pdf",
        mimeType: "application/pdf",
        size: 1234,
        externalAttachmentId: "remote-2",
      },
    ],
    contextParts: [
      {
        partId: "0.0",
        mimeType: "text/plain",
        inlineData: "aW52b2ljZQ",
        charset: "iso-8859-1",
        flowed: true,
        delSp: true,
      },
      {
        partId: "0.1",
        mimeType: "text/html",
        inlineData: "PGI-aW52b2ljZTwvYj4",
      },
    ],
  });
});

test("ordinary text is context while named text and inline images are excluded", () => {
  const plan = buildGmailMessagePartPlan({
    partId: "",
    mimeType: "multipart/mixed",
    filename: "",
    headers: [],
    body: {},
    parts: [
      leaf("1", "text/plain", { data: "Ym9keQ" }),
      leaf("2", "text/plain", { filename: "notes.txt", data: "bm90ZXM" }),
      leaf("3", "image/png", {
        data: "iVBORw",
        headers: [{ name: "Content-Disposition", value: "inline" }],
      }),
    ],
  });

  assert.deepEqual(plan?.contextParts, [
    { partId: "1", mimeType: "text/plain", inlineData: "Ym9keQ" },
  ]);
  assert.deepEqual(plan?.attachments, []);
});

test("non-PDF attachments affect ordinals but are not candidates", () => {
  const plan = buildGmailMessagePartPlan({
    partId: "",
    mimeType: "multipart/mixed",
    filename: "",
    headers: [],
    body: {},
    parts: [
      leaf("1", "application/zip", {
        filename: "bundle.zip",
        attachmentId: "archive",
        headers: [{ name: "Content-Disposition", value: "attachment" }],
      }),
      leaf("2", "image/jpeg", {
        filename: "invoice.jpg",
        data: "_9j_",
      }),
      leaf("3", "application/pdf", { data: "JVBERg" }),
    ],
  });

  assert.deepEqual(plan?.attachments, [
    {
      partId: "3",
      attachmentId: "3:attachment-3",
      originalName: "attachment-3",
      mimeType: "application/pdf",
      size: null,
      inlineData: "JVBERg",
    },
  ]);
});

test("Gmail plan makes unsafe names safe and supports a single-part root", () => {
  const plan = buildGmailMessagePartPlan(
    leaf("", "application/pdf", {
      filename: "../folder\\July.pdf",
      data: "JVBERg",
      headers: [{ name: "Content-Disposition", value: "attachment" }],
    }),
  );

  assert.deepEqual(plan?.attachments[0], {
    partId: "0",
    attachmentId: "1:July.pdf",
    originalName: "July.pdf",
    mimeType: "application/pdf",
    size: null,
    inlineData: "JVBERg",
  });
});

test("Gmail plan rejects malformed trees and nested messages", () => {
  assert.equal(buildGmailMessagePartPlan(undefined), undefined);
  assert.equal(
    buildGmailMessagePartPlan({
      partId: "",
      mimeType: "multipart/mixed",
      filename: "",
      headers: [],
      body: {},
      parts: [],
    }),
    undefined,
  );
  assert.equal(
    buildGmailMessagePartPlan({
      partId: "",
      mimeType: "multipart/mixed",
      filename: "",
      headers: [],
      body: {},
      parts: [leaf("bad/id", "application/pdf", { data: "JVBERg" })],
    }),
    undefined,
  );
  assert.equal(
    buildGmailMessagePartPlan(
      leaf("0", "message/rfc822", { attachmentId: "nested" }),
    ),
    undefined,
  );
  assert.equal(
    buildGmailMessagePartPlan({
      partId: "",
      mimeType: "multipart/mixed",
      filename: "",
      headers: [],
      body: {},
      parts: [leaf("1", "text/plain"), leaf("1", "application/pdf")],
    }),
    undefined,
  );
});
