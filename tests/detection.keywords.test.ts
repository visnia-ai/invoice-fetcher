import assert from "node:assert/strict";
import test from "node:test";

import {
  INVOICE_KEYWORDS,
  matchesInvoiceKeyword,
  matchesReceiptKeyword,
  normalizeSearchText,
} from "../src/detection/index.js";

test("exports every planned multilingual keyword", () => {
  assert.deepEqual(INVOICE_KEYWORDS, [
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
  ]);
});

test("matches Latin and Cyrillic terms case-insensitively as whole words", () => {
  for (const sample of [
    "April INVOICE 123",
    "Payment RECEIPT.pdf",
    "utility bill.pdf",
    "Votre facture_2026",
    "RECHNUNG-99",
    "Fattura (finale)",
    "FACTURA 3",
    "factuur.2026",
    "fatura+tax",
    "Ваш счёт готов",
    "СЧЕТ-ФАКТУРА 42",
  ]) {
    assert.equal(matchesInvoiceKeyword(sample), true, sample);
  }
});

test("does not match Latin or Cyrillic terms embedded inside words", () => {
  for (const sample of [
    "invoiced",
    "receipts",
    "billing",
    "prefacturepost",
    "abrechnungseinheit",
    "fatturazione",
    "facturacion",
    "myfactuurcopy",
    "faturas",
    "пересчет",
  ]) {
    assert.equal(matchesInvoiceKeyword(sample), false, sample);
  }
});

test("matches CJK terms as substrings", () => {
  assert.equal(matchesInvoiceKeyword("电子发票通知"), true);
  assert.equal(matchesInvoiceKeyword("電子發票通知"), true);
  assert.equal(matchesInvoiceKeyword("今月の請求書です"), true);
});

test("uses NFKC normalization", () => {
  assert.equal(normalizeSearchText("ＩＮＶＯＩＣＥ"), "invoice");
  assert.equal(matchesInvoiceKeyword("ＩＮＶＯＩＣＥ 12"), true);
  assert.equal(matchesReceiptKeyword("ＰＡＹＭＥＮＴ ＲＥＣＥＩＰＴ"), true);
  assert.equal(matchesReceiptKeyword("receipts"), false);
});
