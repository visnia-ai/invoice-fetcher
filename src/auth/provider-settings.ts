import type {
  GoogleAccessToken,
  ImapConnectionSettings,
  ImapOAuth2Auth,
} from "./types.js";

export const GMAIL_IMAP_SETTINGS: ImapConnectionSettings = Object.freeze({
  host: "imap.gmail.com",
  port: 993,
  tlsMode: "implicit-tls",
});

export function createGmailImapAuth(
  email: string,
  token: GoogleAccessToken | string,
): ImapOAuth2Auth {
  const username = normalizeEmail(email);
  const accessToken = typeof token === "string" ? token : token.accessToken;
  if (accessToken.trim().length === 0) {
    throw new TypeError("Google OAuth access token must not be empty.");
  }
  return { method: "oauth2", username, accessToken };
}

function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
    throw new TypeError("A valid account email is required.");
  }
  return email;
}
