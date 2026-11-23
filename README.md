# Message Blaster

Prepare and operate opted-in campaigns of up to 5,000 records with local Excel workbooks, PDF attachments and SQLite. Send through a Gmail or Google Workspace account using SMTP with a Google App Password, or through WhatsApp Business using Baileys, an unofficial WhatsApp linked-device library. WhatsApp can restrict an account or change its protocol. The sending settings are operational controls and carry no guarantee against account restrictions.

## Web dashboard

```bash
npm ci
npm run web
```

Open **http://127.0.0.1:3000**. The dashboard binds to loopback and shares the CLI database, attachment library, and delivery settings. Use `WEB_PORT` in `.env` to change the port. The first dashboard launch applies database migrations automatically.

1. Choose **New campaign** and tick Gmail, WhatsApp, or both. Download the empty Excel template for that choice (also under **Excel template** above the queue; it holds only the column titles), add your recipients, and use `Opted In` for recipients who have consented. Ticking both creates two campaigns, `<name>-gmail` and `<name>-whatsapp`, from one combined workbook. Rows without an email address or phone number are left out of that channel only.
2. Upload the workbook. Enter a fallback subject, fallback message, or attachment for blank workbook cells. In the message, type `{{` to insert a personalization field. With `GROQ_API_KEY` set, describe the message and select **Write** to draft the subject and message with Groq. Review the draft before importing. Upload attachments from the editor or the **Attachments** library. Attachments can be any common format (documents, spreadsheets, images, and more) up to 10 MB; programs and scripts such as `.exe` or `.js` are refused because Gmail blocks them. Select **View** to open a file in the document viewer, which previews PDFs, images, text, CSV, Word `.docx`, and Excel `.xlsx` files and offers a download for other formats. To update a file, upload it under a new filename and choose it in the draft. The workbook's `PDF Filename` column accepts any attachment name.
3. Select **Import and preview** and review the rendered messages and skipped rows. Use **Edit** to revise a dashboard draft or replace its workbook before its first run.
4. Set `DRY_RUN=false` in `.env` and restart the dashboard to enable live sending. Use the channel’s CLI commands below to send and confirm a test first. Start or resume the campaign by entering its ID in the approval dialog.

The dashboard streams queued, processing, completed, failed, and review counts. Its worker continues when you close the tab. Keep the dashboard process running during delivery. Pause and cancel stop new claims and let in-flight submissions settle. **Retry failed** puts verified failures back in the queue, and **Resume sending** requires a fresh approval. For uncertain outcomes, use **Review outcome** after checking the delivery result. Deletion is permanent for the campaign and its history, and the attachment files and consent withdrawals remain available.

## Install and run a dry run

Use Node.js 24 LTS and npm. Run commands from the project directory.

```bash
npm ci
cp .env.example .env
npm run setup
npm run campaign:import -- sample
npm run campaign:preview -- sample
npm run campaign:start -- sample
npm run campaign:export -- sample
```

Setup creates the local directories, applies database migrations and generates `data/clients.xlsx` if it is missing. The workbook contains one fictional `Not Opted In` example. Its preview should show zero eligible recipients and a Draft campaign. To try a template from scratch, run `npm run excel:generate -- --file ./data/new-clients.xlsx`.

## Prepare a WhatsApp campaign

1. Fill in **Client ID**, **Client Name**, **Phone Number**, and **Consent Status**. Use `Opted In` only when you have consent for the WhatsApp message. Format phone numbers and identifiers as text in Excel, especially when they start with zero or a plus sign. Local numbers default to Malaysia (`MY`). Use `DEFAULT_COUNTRY` to change the default.
2. Enter a personalized **Message**, an attachment name in **PDF Filename** (or **Attachment**), or both. The name must refer to a file uploaded in the dashboard's **Attachments** library, which is stored in `ATTACHMENTS_DIR`. Leave it blank for text-only messages. If both fields are supplied, the message is the PDF caption.
3. Set **Campaign ID** to the identifier you will pass to the CLI, or leave it blank to include the row in the selected campaign. Rows tagged with another ID are excluded. Remove unrelated untagged rows before importing. The remaining workbook columns report results and are ignored on import.
4. Import and preview the snapshot. The optional `--template` argument sets the fallback for rows with a blank Message. Template placeholders are `{{client_name}}`, `{{client_id}}`, `{{phone_number}}`, `{{campaign_id}}` and `{{pdf_filename}}`.

```bash
npm run campaign:import -- documents-2026 --file ./data/clients.xlsx --template ./your-sales-script.txt
npm run campaign:preview -- documents-2026 --limit 100
npm run campaign:start -- documents-2026
```

Invalid phones, conflicting duplicate phone numbers or client IDs, missing consent, withdrawn consent, invalid templates and attachment errors are reported on skipped records. All rows sharing a duplicate identifier within the selected campaign are excluded. A campaign with no eligible rows remains Draft. Imports create immutable snapshots under new IDs. Correct the workbook and use a new campaign ID when preparing a replacement. Use a separate terminal to record opt-outs as they arrive.

```bash
npm run consent:withdraw -- '<international-or-local-phone>'
```

Withdrawal applies to future claims and skips pending messages for that phone number across existing campaigns. A submission already in flight can still complete.

## Link and verify one test contact

From an interactive terminal, run the connect command and scan the QR code from **WhatsApp Business → Linked devices → Link a device**. The application stores the linked session locally. If WhatsApp logs the session out, stop commands using it, move the existing auth directory to a private archive and pair again. The process uses a lock per auth directory and a lock per linked account on the current machine and OS user.

```bash
npm run whatsapp:connect
npm run whatsapp:test -- first-test --phone '<your-opted-in-test-number>' --consent
```

Review the one-contact preview, then set `DRY_RUN=false` in `.env`. Run the approved test. After independently checking that the recipient received it, record that result. To test an attachment, upload it in the dashboard and pass `--pdf <filename>` when preparing the test; use `--message` to override its text.

```bash
npm run whatsapp:test -- first-test --live --approve first-test
npm run whatsapp:confirm-test -- first-test --received
```

The confirmation is tied to the linked account. A live campaign requires confirmation for that account, `DRY_RUN=false`, `--live`, and `--approve` with the exact campaign ID. A campaign stays bound to the account selected for its first live run.

## Send a Gmail campaign

Enable 2-Step Verification and create a Google App Password. Set the full sender address and App Password in your local `.env`. The CLI uses `smtp.gmail.com` over TLS on port `465`. [Google App Passwords](https://support.google.com/accounts/answer/185833) · [Gmail SMTP settings](https://knowledge.workspace.google.com/admin/gmail/send-email-from-a-printer-scanner-or-app)

```dotenv
GMAIL_USER=your-address@gmail.com
GMAIL_APP_PASSWORD="your Google App Password"
```

Prepare a test addressed to yourself or an opted-in test recipient. Review the preview, set `DRY_RUN=false` in `.env`, and run the approved test. After checking the inbox, confirm receipt for that sender account.

```bash
npm run gmail:test -- gmail-test --email '<your-test-address>' --consent
npm run gmail:test -- gmail-test --live --approve gmail-test
npm run gmail:confirm-test -- gmail-test --received
```

Generate a Gmail workbook and fill in **Client ID**, **Client Name**, **Email Address**, **Subject**, **Consent Status**, and a **Message**, a **PDF Filename**, or both. Use `Opted In` for recipients who consented to receive this email. Set **Campaign ID** to the ID you will import, or leave it blank. Delete the sample row before importing. The subject and plain-text body support `{{client_name}}`, `{{client_id}}`, `{{email_address}}`, `{{campaign_id}}`, and `{{pdf_filename}}`. A `--template` file supplies the body for rows with a blank Message.

```bash
npm run excel:generate -- --channel gmail
npm run campaign:import -- monthly-email --channel gmail
npm run campaign:preview -- monthly-email
npm run campaign:start -- monthly-email --live --approve monthly-email
npm run campaign:status -- monthly-email --attempts
```

The default Gmail workbook is `./data/gmail-clients.xlsx`. Use `--file <path>` to select another workbook. Start, resume, pause, cancel, recovery, and export use the saved campaign channel. Each recipient gets an individual email. Gmail's account sending limits still apply. [Personal Gmail limits](https://support.google.com/mail/answer/22839) · [Google Workspace SMTP limits](https://knowledge.workspace.google.com/admin/gmail/send-email-from-a-printer-scanner-or-app#option-2-send-email-with-the-gmail-smtp-server)

```bash
npm run consent:withdraw -- 'recipient@example.com' --channel gmail
```

Gmail exports include the email subject, Message-ID, and SMTP acceptance timestamp. `SENT` means Gmail's SMTP server accepted the message. Check the sender inbox for delivery failure notices and use the test recipient's inbox to confirm receipt.

## Operate a campaign

```bash
npm run campaign:start -- documents-2026 --live --approve documents-2026
npm run campaign:status -- documents-2026 --attempts
npm run campaign:pause -- documents-2026
npm run campaign:resume -- documents-2026 --live --approve documents-2026
npm run campaign:cancel -- documents-2026
npm run campaign:export -- documents-2026 --output ./storage/documents-2026-results.xlsx
```

The worker runs in the foreground. Use another terminal to pause or cancel, or press Ctrl+C in the worker terminal to stop claiming messages and let active attempts settle. The worker pauses pending work when its run limit is reached. Resume requires fresh approval. Run `npm run campaign:recover` after a crash to reconcile in-flight records before resuming. The next approved live run also performs this recovery. Campaign states are Draft, Ready, Running, Paused, Completed, Failed and Cancelled. Completed means queue processing finished. Check the individual records for failed, skipped and unresolved outcomes.

`SENT` records submission. For WhatsApp, the server acknowledgement, delivery and read timestamps are stored separately when those events are observed. Delivery and read events advance the record to `DELIVERED` or `READ`. A connection cannot observe all late events after it has closed. Run `npm run whatsapp:connect -- --listen` when no worker is running to receive additional updates as WhatsApp supplies them.

`UNKNOWN` means an interrupted or rejected attempt needs review. It is never automatically resent. Incoming receipt evidence can resolve a record, or an operator can record a verified result using the record ID from preview. Automatically scheduled retries are limited to failures known to occur before the transport is invoked.

```bash
npm run campaign:review -- 42 --outcome SENT --note 'Recipient confirmed receipt'
```

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | `./storage/app.db` | Local SQLite database path |
| `EXCEL_FILE` | `./data/clients.xlsx` | Default WhatsApp workbook |
| `GMAIL_EXCEL_FILE` | `./data/gmail-clients.xlsx` | Default Gmail workbook |
| `GMAIL_USER` | Empty | Full Google account email address used for SMTP |
| `GMAIL_APP_PASSWORD` | Empty | Google App Password used for SMTP authentication |
| `GROQ_API_KEY` | Empty | Groq API key for AI drafting in the dashboard. AI writing is hidden when empty |
| `GROQ_MODEL` | `openai/gpt-oss-120b` | Groq model used for AI drafting |
| `ATTACHMENTS_DIR` | `./storage/attachments` | Private folder for files uploaded in the dashboard |
| `AUTH_DIR` | `./auth` | Private SQLite credentials and connection lock |
| `LOG_DIR` | `./logs` | Structured application log directory |
| `DEFAULT_COUNTRY` | `MY` | Region for local phone numbers |
| `MAX_MESSAGES_PER_RUN` | `100` | Maximum attempted records, including retries, in one invocation |
| `MESSAGE_DELAY_MS` | `10000` | Minimum spacing between submission starts in one invocation |
| `SENDER_CONCURRENCY` | `1` | Maximum simultaneous submissions |
| `MAX_RETRY_ATTEMPTS` | `3` | Additional attempts for known pre-submission transient failures |
| `RETRY_DELAY_MS` | `5000` | Initial delay for a safe retry, with exponential backoff |
| `RECEIPT_WAIT_MS` | `5000` | Time to observe WhatsApp receipts after a run |
| `DRY_RUN` | `true` | Blocks live delivery when true |
| `REQUIRE_MANUAL_APPROVAL` | `true` | Must be true. Explicit approval is always enforced |
| `LOG_LEVEL` | `info` | Pino log level |
| `WEB_PORT` | `3000` | Local dashboard port |

## Settings in the dashboard

Open **Settings** in the top bar:

- **Gmail**: the sender address and Google App Password. The password is stored in the local database and never sent back to the browser. Leave it blank to keep the saved one, and use **Check connection** to confirm Gmail accepts it.
- **WhatsApp**: select **Link with QR code**, then scan the code from WhatsApp → Settings → Linked devices → Link a device. **Unlink** archives the stored session next to `AUTH_DIR`; also remove the device from Linked devices on the phone.
- **Sending**: the country used for phone numbers without a `+` code, and the pause between messages.

Saved settings take precedence over `.env` for the dashboard and the CLI. A first send from a new sender still needs the channel's `test` and `confirm-test` commands.

## Browser tests

```bash
npm run test:e2e   # headless Cypress run
npm run cy:open    # interactive Cypress runner
```

Cypress starts its own dry-run dashboard on port 4319 with a separate database at `storage/cypress/cypress.db`, attachments in `storage/cypress/attachments`, and WhatsApp session data in `storage/cypress/auth`. Every test empties that database first. AI drafting, the Gmail connection check, and WhatsApp pairing are stubbed in the browser, so tests never call Groq, Gmail, or WhatsApp.

## Data and maintenance

- `src/database/` owns SQLite initialization and versioned migrations. `message.service.ts` handles campaigns, queue transitions, consent, attempts and receipt timestamps in SQLite.
- `campaign.service.ts` validates import rows and renders message snapshots. The worker checks attachment content against the imported hash before submitting it.
- `live-campaign.service.ts` manages live approval, worker locking, session lifetime and shutdown.
- `whatsapp.service.ts` and `gmail.service.ts` implement the `MessageTransport` interface. WhatsApp supplies receipt events and Gmail supplies SMTP acceptance.
- The workbook, database, logs, backups and auth state may contain private data. The default directories and private file types are ignored by Git. Keep them in access-controlled locations. SQLite files are stored locally with private file permissions.
- Back up with `npm run db:backup -- ./storage/backup.db`. To open a backup, stop workers and point `DATABASE_URL` at the backup file or a copy. A database backup contains the state as of its snapshot. Reconcile messages sent after the snapshot before resuming any restored campaign. Store account credentials independently if you need to preserve the linked session.
- Run `npm run format` to apply ESLint formatting with four-space indentation. Run `npm run lint` to check it without editing files, or `npm run check` to run ESLint, TypeScript checks, and tests. Tests use temporary workbooks and SQLite databases with simulated transport and SMTP responses.

Baileys is maintained by WhiskeySockets. [Baileys quickstart](https://github.com/WhiskeySockets/docs/blob/main/quickstart.mdx)
