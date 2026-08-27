![Invoice Fetcher](assets/readme-header.jpg)

# Invoice Fetcher

A local cross-platform CLI that finds invoice PDF attachments through the Gmail API or IMAP and organizes them by sender domain and month. Google accounts use the Gmail API; generic accounts use IMAP.

## Install

Requires Node.js 22+ on one of these supported platforms:

- macOS x64 or ARM64
- Linux x64 or ARM64
- Windows x64

```sh
npm install
npm run build
npm link
```

## Configure an account

Generic IMAP prompts for encrypted connection settings and a password:

```sh
invoice-fetcher add imap accounts@example.com
```

For Gmail, the guided setup creates a dedicated Cloud project, enables the Gmail API, and opens the few Google Auth Platform screens that still require manual confirmation:

```sh
invoice-fetcher add google accounts@gmail.com
```

If a working system `gcloud` is available, invoice-fetcher uses it. Otherwise, the first guided setup downloads the matching archive from Google's [official versioned archives](https://cloud.google.com/sdk/docs/downloads-versioned-archives), verifies its SHA-256 checksum, and caches the self-contained CLI in the platform's application cache directory. It does not modify your PATH or shell configuration.

Sign in to Google Cloud with the same Google account when prompted. In the opened Google Auth Platform pages, configure an External audience, add only the `https://www.googleapis.com/auth/gmail.readonly` scope, publish the personal app to **In production** for durable access, and create a **Desktop app** client. Paste its client ID and client secret back into the terminal. The secret and refresh token are stored only in the operating system credential vault. The managed Google Cloud CLI requires Python 3.10–3.14 when its archive does not include Python.

To use an OAuth client JSON that you created separately and bypass both system and managed `gcloud` entirely:

```sh
invoice-fetcher add google accounts@gmail.com --oauth-client ~/Downloads/client_secret.json
```

Interrupted guided setup resumes its existing dedicated project. Removing an account does not delete that Google Cloud project.

Manage configured accounts with `invoice-fetcher list` and `invoice-fetcher remove <email>`. Pass `--replace` to reconfigure an existing account.

Accounts configured by an older invoice-fetcher release used broader Gmail permissions. Migrate one by revoking its previous grant and authorizing read-only access:

```sh
invoice-fetcher add google accounts@gmail.com --replace
```

Configuration and managed tools use the platform conventions:

| Platform | Configuration                                                       | Managed tools                                                                 |
| -------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| macOS    | `~/Library/Application Support/invoice-fetcher/`                    | Same directory under `tools/`                                                 |
| Linux    | `$XDG_CONFIG_HOME/invoice-fetcher/` or `~/.config/invoice-fetcher/` | `$XDG_CACHE_HOME/invoice-fetcher/tools/` or `~/.cache/invoice-fetcher/tools/` |
| Windows  | `%APPDATA%\invoice-fetcher\`                                        | `%LOCALAPPDATA%\invoice-fetcher\tools\`                                       |

## Usage

```sh
invoice-fetcher <start-date> <end-date> <email-address> <destination-folder>
```

Example:

```sh
invoice-fetcher 2026-01-01 2026-03-31 accounts@example.com ~/Documents/Invoices
```

Dates use inclusive `YYYY-MM-DD` bounds. The email address selects a previously configured account.

The CLI:

- Searches received mail while excluding Sent, Drafts, Junk, Trash, and Outbox; Gmail uses the Gmail API and filters for attachments on the server.
- Considers only PDF attachments and detects invoices from multilingual filenames and PDF text.
- Includes textless or unreadable PDFs conservatively and processes everything locally.
- Deduplicates identical files without overwriting existing invoices.

Interactive terminals show live mail-scan progress with percentages, counts, and ETAs. When output is redirected to a file, compact progress milestones are written every 10% instead of terminal control sequences.

Multi-month searches produce:

```text
destination/
  2026-01/
    sender.example/
      invoice.pdf
```
