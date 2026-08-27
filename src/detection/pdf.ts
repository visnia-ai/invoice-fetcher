import { readFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

interface PdfTextItem {
  str?: unknown;
}

interface PdfPage {
  getTextContent(): Promise<{ items: PdfTextItem[] }>;
}

interface PdfDocument {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPage>;
  destroy?(): Promise<void> | void;
}

interface PdfLoadingTask {
  promise: Promise<PdfDocument>;
}

export type PdfLoader = (data: Uint8Array) => PdfLoadingTask;

export interface PdfTextExtraction {
  text: string;
  pageCount: number;
  hasText: boolean;
}

async function defaultPdfLoader(data: Uint8Array): Promise<PdfLoadingTask> {
  // This is PDF.js's supported Node entry point.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const packageDirectory = dirname(
    fileURLToPath(import.meta.resolve("pdfjs-dist/package.json")),
  );
  return pdfjs.getDocument({
    data,
    cMapUrl: `${join(packageDirectory, "cmaps")}${sep}`,
    cMapPacked: true,
    standardFontDataUrl: `${join(packageDirectory, "standard_fonts")}${sep}`,
    wasmUrl: `${join(packageDirectory, "wasm")}${sep}`,
  }) as unknown as PdfLoadingTask;
}

/** Extract text from every PDF page. The loader is injectable for deterministic tests. */
export async function extractPdfText(
  filePath: string,
  loader?: PdfLoader,
): Promise<PdfTextExtraction> {
  const data = new Uint8Array(await readFile(filePath));
  const loadingTask = loader ? loader(data) : await defaultPdfLoader(data);
  const document = await loadingTask.promise;
  const pageTexts: string[] = [];

  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => (typeof item.str === "string" ? item.str : ""))
        .filter(Boolean)
        .join(" ");
      pageTexts.push(text);
    }
  } finally {
    await document.destroy?.();
  }

  const text = pageTexts.join("\n");
  return { text, pageCount: document.numPages, hasText: text.trim().length > 0 };
}
