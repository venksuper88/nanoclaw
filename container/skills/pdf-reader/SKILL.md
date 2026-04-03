---
name: pdf-reader
description: Extract text from PDF files using pdftotext CLI. Use when a user sends a PDF attachment or asks you to read a PDF file.
---

# PDF Reader

Extract text from PDF files using `pdftotext` (poppler-utils). Available on the host at `/opt/homebrew/bin/pdftotext`.

## When to use

- User sends a PDF attachment (message contains `[File: *.pdf]` or `[Document: *.pdf]`)
- User asks you to read, summarize, or extract data from a PDF
- You need to parse a PDF file from the attachments directory

## How to use

### Extract text from a PDF file

```bash
pdftotext /path/to/file.pdf -
```

The `-` flag outputs to stdout. The file path is in the attachments directory shown in the `<context attachments="...">` header of each message.

### Extract specific pages

```bash
pdftotext -f 1 -l 5 /path/to/file.pdf -
```

`-f` = first page, `-l` = last page.

### Get PDF info (page count, metadata)

```bash
pdfinfo /path/to/file.pdf
```

## Important notes

- **Use pdftotext first** for any PDF — it's fast and cheap (no vision tokens)
- If pdftotext returns empty/garbled text, the PDF is likely scanned (image-based). Fall back to the agent-browser skill to view it visually.
- **Never use the Read tool on PDFs** — it wastes context. Use pdftotext via Bash instead.
- Attachments directory path is in the `<context attachments="...">` XML header of your messages.
