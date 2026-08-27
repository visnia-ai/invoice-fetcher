/** Built-in invoice terms. Latin and Cyrillic terms use whole-word matching. */
export const INVOICE_TERMS = [
  "invoice",
  "receipt",
  "bill",
  "facture",
  "rechnung",
  "fattura",
  "factura",
  "factuur",
  "fatura",
  "счёт",
  "счет",
  "счёт-фактура",
  "счет-фактура",
  "发票",
  "發票",
  "請求書",
] as const;

/** Public integration name used by the Mail bridge. */
export const INVOICE_KEYWORDS = INVOICE_TERMS;

const CJK_TERMS = INVOICE_TERMS.filter((term) => /[\p{Script=Han}]/u.test(term));
const WHOLE_WORD_TERMS = INVOICE_TERMS.filter(
  (term) => !/[\p{Script=Han}]/u.test(term),
);

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const WHOLE_WORD_PATTERNS = WHOLE_WORD_TERMS.map(
  (term) =>
    new RegExp(
      `(?<![\\p{L}\\p{N}])${escapeRegExp(normalizeSearchText(term))}(?![\\p{L}\\p{N}])`,
      "u",
    ),
);

const RECEIPT_PATTERN = new RegExp(
  `(?<![\\p{L}\\p{N}])${escapeRegExp(normalizeSearchText("receipt"))}(?![\\p{L}\\p{N}])`,
  "u",
);

/** Normalize compatibility characters and case without changing word boundaries. */
export function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("und");
}

/** Match any built-in invoice term using language-appropriate boundary rules. */
export function matchesInvoiceKeyword(value: string): boolean {
  const normalized = normalizeSearchText(value);
  return (
    CJK_TERMS.some((term) => normalized.includes(normalizeSearchText(term))) ||
    WHOLE_WORD_PATTERNS.some((pattern) => pattern.test(normalized))
  );
}

/** Match the receipt signal independently from the broader invoice terms. */
export function matchesReceiptKeyword(value: string): boolean {
  return RECEIPT_PATTERN.test(normalizeSearchText(value));
}
