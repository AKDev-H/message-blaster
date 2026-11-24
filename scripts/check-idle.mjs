// Runs before `npm ci`, so it must not import anything from node_modules.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { parseEnv } from 'node:util';

const db = databasePath();
if (existsSync(db)) {
    const running = runningCampaigns(db);
    if (running.length) {
        console.error(`Campaigns are sending: ${running.join(', ')}.`);
        console.error('A reload now pauses them and needs a manual resume. Wait, pause them first, or rerun with FORCE_DEPLOY=1.');
        process.exitCode = process.env.FORCE_DEPLOY === '1' ? 0 : 1;
    }
}

function databasePath() {
    const fromFile = existsSync('.env') ? parseEnv(readFileSync('.env', 'utf8')) : {};
    const value = (process.env.DATABASE_URL ?? fromFile.DATABASE_URL ?? '').trim() || './storage/app.db';
    return value.replace(/^~(?=\/|$)/u, homedir());
}

function runningCampaigns(path) {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
        return db.prepare("SELECT id FROM campaigns WHERE state = 'Running' ORDER BY id").all().map(row => String(row.id));
    } finally {
        db.close();
    }
}
