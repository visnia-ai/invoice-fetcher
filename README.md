![Invoice Fetcher](assets/readme-header.jpg)

# Invoice Fetcher

A dead simple CLI that helps you automatically find and download invoices and receipts in your inbox, so you can close your books faster. Everything is processed locally, and no data is sent to third parties.

## Table of contents

- [Install](#install)
- [Configure an account](#configure-an-account)
  - [IMAP-based account](#imap-based-account)
  - [Gmail account](#gmail-account)
- [Usage](#usage)

## Install

Requires Node.js 22+

```sh
npm install
npm run build
npm link
```

## Configure an account

### IMAP-based account

Run this command and follow the instructions:

```sh
invoice-fetcher add imap accounts@example.com
```

### Gmail account

Google requires OAuth read-only authorization to the Gmail API. Run this command and follow the instructions of the guided setup to authenticate your google account:

```sh
invoice-fetcher add google accounts@gmail.com
```

## Usage

```sh
invoice-fetcher <start-date> <end-date> <email-address> <destination-folder>
```

Example:

```sh
invoice-fetcher 2026-01-01 2026-03-31 accounts@example.com ~/Documents/Invoices
```

Dates use inclusive `YYYY-MM-DD` bounds. The email address selects a previously configured account.

Multi-month searches produce:

```text
destination/
└── 2026-01/
    └── sender.example/
        └── invoice.pdf
```
