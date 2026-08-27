import assert from "node:assert/strict";
import test from "node:test";

import {
  GMAIL_IMAP_SETTINGS,
  createGmailImapAuth,
} from "../src/auth/index.js";

test("provides fixed encrypted Gmail IMAP settings", () => {
  assert.deepEqual(GMAIL_IMAP_SETTINGS, {
    host: "imap.gmail.com",
    port: 993,
    tlsMode: "implicit-tls",
  });
});

test("adapts an in-memory Google access token for IMAP", () => {
  assert.deepEqual(createGmailImapAuth(" Person@Example.com ", "access-token"), {
    method: "oauth2",
    username: "person@example.com",
    accessToken: "access-token",
  });
});

test("rejects empty provider secrets", () => {
  assert.throws(() => createGmailImapAuth("person@example.com", "  "), /must not be empty/u);
});
