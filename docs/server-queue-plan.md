# Server-Side Queue & Detached Campaign Execution

## Goal
After **Start sending** on a campaign of 100–1,000+ contacts:
- Contacts are stored in one transaction without stalling the dashboard.
- Sending runs entirely on the server, so the user can close the tab or the laptop lid.
- When the user comes back, the page catches up at once and keeps updating live.

## How it works (implemented)

```
Browser ── POST send (group/channel routes) ──► web server ── 202 Accepted
                                                    │
                                                    ├─ spawns CLI worker process (src/web/runner.ts)
                                                    │     claim QUEUED → SENDING (UPDATE … RETURNING)
                                                    │     paced send → SENT / FAILED / retry_at
                                                    ▼
                                         SQLite (WAL, synchronous=FULL)
                                                    │
Browser ◄── SSE /api/events (snapshot on connect, change events, ping every 15s)
```

| Concern | Where |
|---|---|
| Import in one `BEGIN IMMEDIATE` transaction with a prepared insert | `src/store/store.ts` (`importCampaign`), `src/store/recipients.ts` |
| Rows inserted as `PENDING`/`SKIPPED`, moved to `QUEUED` at launch | `src/store/lifecycle.ts` (`activateCampaign`) |
| Queue index `messages(campaign_id, status, retry_at, id)` | `src/database/migrations/001-initial.ts` |
| Atomic claim, one worker per database (lock file) | `src/store/delivery.ts`, `src/services/worker-lock.ts` |
| `202` and a worker outside the request | `src/web/routes/campaigns/delivery.ts`, `src/web/runner.ts` |
| Process supervision | `ecosystem.config.cjs` (PM2, single instance) |
| Live updates | `src/web/live-updates.ts`, `web/app.mjs` |

## Decisions to keep

- **Interrupted messages become `UNKNOWN`. They are never put back in the queue.** A message left in `SENDING` may already have reached the provider. Requeuing it risks a duplicate send, so a person reviews it instead (`src/store/receipts.ts`).
- **`synchronous = FULL`, not `NORMAL`.** In WAL mode, `NORMAL` can lose the last commits on power loss. Those commits include `SENT` results, which would then be sent again. Import is a single transaction, so `FULL` costs one fsync.
- **Withdrawal checks stay per-row indexed lookups.** That's well under 1ms for 1,000 rows, so there's no need for an in-memory preload.
- `node:sqlite` is synchronous, so an import does block the event loop while it runs. Keep imports in one transaction so that time stays short.

## Restarts and deploys

A server restart **pauses** any running campaign. It does not resume it automatically, because resuming would send again without fresh approval.
- On a graceful shutdown (PM2 reload or SIGTERM), `WebRunner.close()` stops the worker and sets `campaigns.interrupted_at`.
- After a crash, `recoverInterrupted()` marks in-flight messages `UNKNOWN`, sets the campaign to `Paused` and sets `interrupted_at`.
- The campaign page shows "Sending stopped because the server restarted…" until someone resumes, and resuming clears the flag.
- `scripts/deploy.sh` refuses to deploy while a campaign is `Running` (`scripts/check-idle.ts`). Override with `FORCE_DEPLOY=1`.

## Client wake handling

- `visibilitychange` (when the tab becomes visible) and `online` always re-fetch the current view.
- The server's heartbeat is a real `event: ping`, so the client can tell when a stream has gone silent. If nothing arrives for 40s, or the stream is closed, the client replaces the `EventSource`. After sleep, a dead socket can still report `OPEN`.

## Verification

1. **Import speed:** `scripts/bench-campaigns.ts` and `tests/blast-1000.test.ts` / `cypress/e2e/blast-1000.cy.js`. Measure the whole request, because Excel parsing usually costs more than the insert.
2. **Tab closed / lid closed:** start 100+ recipients on the server, close the laptop for 2 minutes, and check `logs/pm2-out.log` to confirm sending continued at the configured pace.
3. **Catch-up:** reopen the laptop. The page should show the sends made while it was asleep within about a second and go back to live updates.
4. **Deploy mid-campaign:** `npm run deploy` should refuse. With `FORCE_DEPLOY=1`, the campaign ends `Paused` with the restart notice, any in-flight message shows as "Needs review", and resuming sends only the rest.
