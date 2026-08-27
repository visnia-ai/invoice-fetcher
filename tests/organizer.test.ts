import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  extractSenderDomain,
  invoiceDirectory,
  organizeInvoice,
  sanitizeAttachmentName,
} from "../src/organizer.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("organizer", () => {
  it("extracts the exact sender domain", () => {
    assert.equal(extractSenderDomain("Vendor <Billing@eu.example.com>"), "eu.example.com");
    assert.equal(extractSenderDomain("not an address"), "_unknown-sender");
  });

  it("sanitizes traversal and control characters", () => {
    assert.equal(sanitizeAttachmentName("../../bad:name\n.pdf"), "bad_name_.pdf");
    assert.equal(sanitizeAttachmentName("..."), "attachment");
  });

  it("adds an ISO month only for multi-month searches", () => {
    const date = new Date(2026, 0, 12);
    assert.equal(invoiceDirectory("/tmp/out", "a@vendor.com", date, false), "/tmp/out/vendor.com");
    assert.equal(invoiceDirectory("/tmp/out", "a@vendor.com", date, true), "/tmp/out/2026-01/vendor.com");
  });

  it("deduplicates identical files and suffixes different collisions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "invoice-organizer-"));
    temporaryDirectories.push(root);
    const first = path.join(root, "first.pdf");
    const second = path.join(root, "second.pdf");
    await writeFile(first, "one");
    await writeFile(second, "two");
    const common = {
      originalName: "invoice.pdf",
      sender: "Accounts <billing@vendor.example>",
      receivedAt: new Date(2026, 1, 2),
      destinationRoot: path.join(root, "output"),
      spansMultipleMonths: false,
    };

    const copied = await organizeInvoice({ ...common, stagedPath: first });
    const duplicate = await organizeInvoice({ ...common, stagedPath: first });
    const collision = await organizeInvoice({ ...common, stagedPath: second });

    assert.equal(copied.status, "copied");
    assert.equal(duplicate.status, "duplicate");
    assert.equal(collision.status, "copied");
    assert.match(collision.destinationPath, /invoice \(2\)\.pdf$/u);
    assert.equal(await readFile(collision.destinationPath, "utf8"), "two");
  });
});
