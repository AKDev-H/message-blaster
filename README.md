# Message Blaster

Send opted-in campaigns (up to 5,000 recipients) from an Excel workbook through **Gmail** (SMTP + App Password) or **WhatsApp Business** (via [Baileys](https://github.com/WhiskeySockets/docs/blob/main/quickstart.mdx), an unofficial linked-device library). Everything runs locally on SQLite.

> [!WARNING]
> WhatsApp may restrict accounts that use unofficial clients. The rate limits here are safeguards, not guarantees.

```mermaid
flowchart LR
    A[Excel workbook] --> B[Import & validate]
    B --> C[Preview]
    C --> D[Test send + confirm]
    D --> E[Approve campaign ID]
    E --> F[Worker]
    F --> G[Gmail SMTP]
    F --> H[WhatsApp]
    F --> I[(SQLite)]
    I --> J[Export results .xlsx]
```

## Quick start

Requires Node.js 24.

```bash
npm ci
cp .env.example .env
npm run setup     # creates dirs, runs migrations, generates data/clients.xlsx
npm run web       # dashboard at http://127.0.0.1:3000
```

`DRY_RUN=true` is the default, so nothing is sent until you change it.

## Safety model

Live sending requires all of the following:

1. `DRY_RUN=false` in `.env`
2. A test sent to yourself and confirmed as received for that sender account (**Settings › Gmail** or **Settings › WhatsApp** › *Test send*)
3. `--live --approve <campaign-id>` on the CLI, or typing the campaign ID in the dashboard

Only rows with `Consent Status = Opted In` are sent. Invalid, duplicate or withdrawn recipients are skipped and reported.

## Using the dashboard

1. **New campaign**: pick Gmail, WhatsApp or both, then download the Excel template.
2. **Add recipients**: fill in the workbook and upload it, or switch to **Type in** and enter names with an email or phone number (up to 500; paste rows straight from a spreadsheet). Typed recipients are saved as `Opted In` once you confirm their consent. Set fallback subject, message and attachment for blank cells. Type `{{` to insert a field. With `GROQ_API_KEY` set, **Write** drafts copy with AI.
3. **Import and preview**: check the rendered messages and skipped rows.
4. **Start**: enter the campaign ID to approve it. Pause, cancel, retry and review from the queue.

**Settings** holds Gmail credentials (the App Password is stored encrypted), WhatsApp QR linking, send pacing and the **Test send** that unlocks campaigns for each sender account. The dashboard and the CLI both read them. Keep the dashboard running while a campaign sends.

Attachments are any common format up to 10 MB (executables and scripts are refused). Upload them in **Attachments** and reference them by filename in the workbook.

## Workbook columns

| Column | Gmail | WhatsApp | Notes |
| --- | :-: | :-: | --- |
| Client Name | ✓ | ✓ | Required |
| Email Address | ✓ | | |
| Phone Number | | ✓ | Format as text. Local numbers use `DEFAULT_COUNTRY` |
| Subject | ✓ | | |
| Message | ✓ | ✓ | Falls back to `--template` or the dashboard default |
| PDF Filename / Attachment | ✓ | ✓ | Must exist in the attachments library |
| Consent Status | ✓ | ✓ | Only `Opted In` is sent |
| Campaign ID | ✓ | ✓ | Blank means the row belongs to the selected campaign |

Placeholders: `{{client_name}}`, `{{email_address}}`, `{{phone_number}}`, `{{campaign_id}}`, `{{pdf_filename}}`.

## CLI

### Connect and test

```bash
# Usually done in Settings › Test send. CLI equivalent:
# Gmail: save the sender in Settings › Gmail first
npm run gmail:test -- gmail-test --email you@example.com --consent
npm run gmail:test -- gmail-test --live --approve gmail-test
npm run gmail:confirm-test -- gmail-test --received

# WhatsApp: scan the QR code under Linked devices
npm run whatsapp:connect
npm run whatsapp:test -- wa-test --phone '+60123456789' --consent
npm run whatsapp:test -- wa-test --live --approve wa-test
npm run whatsapp:confirm-test -- wa-test --received
```

### Run a campaign

```bash
npm run excel:generate -- --channel gmail                 # blank template
npm run campaign:import  -- july --channel gmail --file ./data/gmail-clients.xlsx
npm run campaign:preview -- july
npm run campaign:start   -- july --live --approve july
npm run campaign:status  -- july --attempts
npm run campaign:pause   -- july
npm run campaign:resume  -- july --live --approve july
npm run campaign:cancel  -- july
npm run campaign:export  -- july --output ./storage/july-results.xlsx
```

### Maintenance

```bash
npm run consent:withdraw -- '+60123456789'                 # or an email with --channel gmail
npm run campaign:recover                                   # after a crash
npm run campaign:review -- 42 --outcome SENT --note 'Confirmed'
npm run whatsapp:connect -- --listen                       # collect late delivery/read receipts
npm run db:backup -- ./storage/backup.db
```

Imports are immutable snapshots. To fix a workbook, re-import it under a new campaign ID.

## Lifecycle

```mermaid
stateDiagram-v2
    direction LR
    [*] --> Draft: import
    Draft --> Ready: eligible rows
    Ready --> Running: approve
    Running --> Paused: pause / run limit
    Paused --> Running: re-approve
    Running --> Completed
    Running --> Failed
    Running --> Cancelled
    Paused --> Cancelled
```

Message statuses:

| Status | Meaning |
| --- | --- |
| `SENT` | Accepted by Gmail SMTP or submitted to WhatsApp |
| `DELIVERED` / `READ` | WhatsApp receipt observed |
| `FAILED` | Verified failure. **Retry failed** re-queues it |
| `SKIPPED` | Excluded at import or by consent withdrawal |
| `UNKNOWN` | Outcome uncertain. Never resent automatically. Resolve it with `campaign:review` |

## Configuration

**In the dashboard (Settings):** Gmail sender and [App Password](https://support.google.com/accounts/answer/185833), WhatsApp link, the country for local phone numbers, the pause between messages, and the test send. The App Password is encrypted (AES-256-GCM) with a key kept outside the project at `~/.config/message-blaster/secret.key`. Back that file up with the database; without it the saved password must be entered again. Values still left in an old `.env` are imported once on start.

**In `.env`** (see `.env.example`):

| Variable | Default | Purpose |
| --- | --- | --- |
| `DRY_RUN` | `true` | Blocks live delivery |
| `WEB_PORT` | `3000` | Dashboard port |
| `GROQ_API_KEY` / `GROQ_MODEL` | — / `openai/gpt-oss-120b` | AI drafting (hidden when no key is set) |
| `MAX_MESSAGES_PER_RUN` | `100` | Attempts per run, including retries |
| `SENDER_CONCURRENCY` | `1` | Parallel sends |
| `MAX_RETRY_ATTEMPTS` / `RETRY_DELAY_MS` | `3` / `5000` | Safe retries with backoff |
| `SECRET_KEY_FILE` | `~/.config/message-blaster/secret.key` | Encryption key for saved secrets |
| `DATABASE_URL`, `ATTACHMENTS_DIR`, `AUTH_DIR`, `LOG_DIR` | `./storage/...`, `./auth`, `./logs` | Local storage paths |

## Development

```bash
npm run check      # lint + typecheck + unit tests
npm run format     # auto-fix formatting
npm run test:e2e   # Cypress, headless (isolated DB on port 4319, external services stubbed)
npm run cy:open    # Cypress, interactive
```

```
src/
  cli/          one file per group of CLI commands
  database/     SQLite connection, transactions, migrations
  store/        everything saved about campaigns: Store class + one module per area
  services/     campaign/, excel/, whatsapp/, gmail, attachments, settings, ai
  workers/      the campaign send loop and payload preparation
  web/          dashboard server: http helpers, live updates, input/ parsing, routes/
  errors.ts     NotFoundError / ConflictError, mapped to HTTP 404 / 409
web/            dashboard frontend
  shared/       DOM and request helpers, icons, labels
  campaigns/    campaign table, details panel, action buttons
  compose/      new/edit campaign dialog, recipients, attachments, AI writer
  editor/       message editor and placeholder menu
  settings/     settings dialog, Gmail/WhatsApp/test-send panels
  viewer/       attachment preview
  dialogs/      confirmation dialog
```

Functions are kept short (a few lines) and named for what they do, so a file reads top to bottom: the exported entry point first, then the steps it calls.

## Privacy

Workbooks, `storage/`, `auth/` and `logs/` may contain personal data and credentials. Git ignores them. Keep them in access-controlled locations.
