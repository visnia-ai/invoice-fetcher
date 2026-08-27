import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { extractPdfText, type PdfLoader } from "../src/detection/index.js";

test("extracts text from every page and destroys the document", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "invoice-detector-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(directory, { recursive: true, force: true });
  });
  const filePath = path.join(directory, "sample.pdf");
  await writeFile(filePath, "fixture bytes");

  let destroyed = false;
  let receivedBytes = 0;
  const loader: PdfLoader = (data) => {
    receivedBytes = data.length;
    return {
      promise: Promise.resolve({
        numPages: 2,
        getPage: async (pageNumber) => ({
          getTextContent: async () => ({
            items: pageNumber === 1
              ? [{ str: "First" }, { str: "page" }, {}]
              : [{ str: "Invoice" }, { str: 42 }, { str: "two" }],
          }),
        }),
        destroy: async () => { destroyed = true; },
      }),
    };
  };

  const result = await extractPdfText(filePath, loader);
  assert.ok(receivedBytes > 0);
  assert.deepEqual(result, {
    text: "First page\nInvoice two",
    pageCount: 2,
    hasText: true,
  });
  assert.equal(destroyed, true);
});

test("marks whitespace-only PDF content as textless", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "invoice-detector-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(directory, { recursive: true, force: true });
  });
  const filePath = path.join(directory, "scan.pdf");
  await writeFile(filePath, "fixture bytes");

  const result = await extractPdfText(filePath, () => ({
    promise: Promise.resolve({
      numPages: 1,
      getPage: async () => ({ getTextContent: async () => ({ items: [{ str: " " }] }) }),
    }),
  }));
  assert.equal(result.hasText, false);
});

test("extracts text through the installed PDF.js runtime", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "invoice-detector-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(directory, { recursive: true, force: true });
  });
  const filePath = path.join(directory, "real.pdf");
  await writeFile(filePath, makePdf("Invoice 2026"));

  const result = await extractPdfText(filePath);

  assert.equal(result.pageCount, 1);
  assert.match(result.text, /Invoice 2026/u);
});

function makePdf(text: string): string {
  const escapedText = text.replace(/[\\()]/gu, (character) => `\\${character}`);
  const stream = `BT /F1 12 Tf 72 720 Td (${escapedText}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return pdf;
}
