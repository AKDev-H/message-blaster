import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { loadEnv } from '../src/config/env.js';

// Reloading the dashboard stops the campaign worker and leaves the campaign Paused, so refuse while one is sending.
const { DATABASE_URL } = loadEnv();
if (existsSync(DATABASE_URL)) {
    const db = new DatabaseSync(DATABASE_URL, { readOnly: true });
    const running = db.prepare("SELECT id FROM campaigns WHERE state = 'Running' ORDER BY id").all().map(row => String(row.id));
    db.close();
    if (running.length) {
        console.error(`Campaigns are sending: ${running.join(', ')}.`);
        console.error('A reload now pauses them and needs a manual resume. Wait, pause them first, or rerun with FORCE_DEPLOY=1.');
        process.exitCode = process.env.FORCE_DEPLOY === '1' ? 0 : 1;
    }
}
