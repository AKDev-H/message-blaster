import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AuthStore } from '../src/auth/store.js';
import { openDatabase } from '../src/database/connection.js';
import { scheduleAuditCleanup } from '../src/web/audit-cleanup.js';

const DAY_MS = 86_400_000;

async function withStore(use: (store: AuthStore, db: ReturnType<typeof openDatabase>) => void | Promise<void>): Promise<void> {
    const directory = await mkdtemp(join(tmpdir(), 'message-blaster-audit-'));
    try {
        using db = openDatabase(join(directory, 'audit.sqlite'));
        await use(new AuthStore(db), db);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

test('audit events are served newest first in numbered pages', () => withStore(store => {
    for (let index = 1; index <= 5; index++) store.audit({ action: `event.${index}`, outcome: 'success' });
    const first = store.auditPage(1, 2);
    assert.deepEqual({ ...first, events: first.events.map(event => event.action) },
        { events: ['event.5', 'event.4'], page: 1, pageSize: 2, totalPages: 3, total: 5 });
    assert.deepEqual(store.auditPage(3, 2).events.map(event => event.action), ['event.1']);
    assert.equal(store.auditPage(99, 2).page, 3, 'a page past the end clamps to the last page');
}));

test('the daily cleanup deletes only audit events older than 90 days', () => withStore((store, db) => {
    const now = Date.now();
    store.audit({ action: 'recent', outcome: 'success' });
    store.audit({ action: 'old', outcome: 'success' });
    db.prepare("UPDATE audit_events SET occurred_at = ? WHERE action = 'old'").run(now - 91 * DAY_MS);
    store.audit({ action: 'edge', outcome: 'success' });
    db.prepare("UPDATE audit_events SET occurred_at = ? WHERE action = 'edge'").run(now - 89 * DAY_MS);

    const job = scheduleAuditCleanup(store, () => now);
    job.stop();
    assert.deepEqual(store.auditPage(1).events.map(event => event.action).sort(), ['edge', 'recent']);
}));

test('an empty audit log has a single empty page', () => withStore(store => {
    assert.deepEqual(store.auditPage(1), { events: [], page: 1, pageSize: 50, totalPages: 1, total: 0 });
}));

test('the cleanup runs again on every interval tick', () => withStore(async store => {
    let clock = Date.now();
    const job = scheduleAuditCleanup(store, () => clock, 20);
    store.audit({ action: 'soon-old', outcome: 'success' });
    clock += 91 * DAY_MS;
    await new Promise(resolve => setTimeout(resolve, 60));
    job.stop();
    assert.equal(store.auditPage(1).total, 0);
}));

test('audit pages filter by an inclusive time range and name each actor', () => withStore((store, db) => {
    const admin = store.bootstrap('ada.lovelace@gmail.com');
    const signedIn = store.createSession('google-ada', admin.email, 'session-hash', Date.now() + DAY_MS,
        { name: 'Ada Lovelace', picture: 'https://lh3.googleusercontent.com/a/ada' });
    assert.deepEqual(signedIn && { name: signedIn.name, picture: signedIn.picture },
        { name: 'Ada Lovelace', picture: 'https://lh3.googleusercontent.com/a/ada' });
    store.createSession('google-ada', admin.email, 'second-hash', Date.now() + DAY_MS, { picture: 'javascript:alert(1)' });
    assert.equal(store.userByEmail(admin.email)?.picture, 'https://lh3.googleusercontent.com/a/ada', 'only https photos are kept');

    db.exec('DELETE FROM audit_events');
    for (const [day, action] of [[1, 'early'], [2, 'middle'], [3, 'late']] as const) {
        db.prepare('INSERT INTO audit_events (occurred_at, actor_id, source, action, outcome) VALUES (?, ?, ?, ?, ?)')
            .run(day * DAY_MS, action === 'middle' ? admin.id : null, 'web', action, 'success');
    }
    const middle = store.auditPage(1, 10, { from: 2 * DAY_MS, to: 2 * DAY_MS });
    assert.deepEqual(middle.events.map(event => [event.action, event.actorName, event.actorEmail, event.actorPicture]),
        [['middle', 'Ada Lovelace', admin.email, 'https://lh3.googleusercontent.com/a/ada']]);
    assert.equal(middle.total, 1);
    assert.deepEqual(store.auditPage(1, 10, { from: 2 * DAY_MS }).events.map(event => event.action), ['late', 'middle']);
    assert.deepEqual(store.auditPage(1, 10, { to: 2 * DAY_MS - 1 }).events.map(event => [event.action, event.actorName]), [['early', null]]);
}));
