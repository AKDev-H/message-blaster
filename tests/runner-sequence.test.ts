import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { DEFAULT_SETTINGS, loadEnv, type Environment } from '../src/config/env.js';
import { openDatabase } from '../src/database/connection.js';
import type { RunMode } from '../src/services/live-campaign.service.js';
import { Store, type Campaign, type CampaignGroup, type PreparedRow } from '../src/store/index.js';
import type { RequestAudit } from '../src/web/auth/audit.js';
import { INTERRUPTED_NOTICE, WebRunner, type LaunchStep } from '../src/web/runner.js';

type Outcome = 'complete' | 'pause' | 'crash' | 'hang';

function row(rowNumber: number, channel: 'gmail' | 'whatsapp'): PreparedRow {
    return {
        rowNumber, clientName: 'Ari', phone: channel === 'whatsapp' ? `+6012345678${rowNumber}` : '', email: `ari${rowNumber}@example.com`,
        subject: 'Hi', message: 'Hello', pdfFilename: '', consentStatus: 'Opted In',
    };
}

function setup(context: TestContext, outcomes: Outcome[]) {
    const db = openDatabase(':memory:');
    context.after(() => db.close());
    const store = new Store(db);
    store.createCampaignGroup({
        slug: 'launch', name: 'launch', shared: { script: 'Hello', subject: 'Hi', attachment: '' },
        campaigns: (['gmail', 'whatsapp'] as const).map(channel => ({ id: `launch-${channel}`, channel, rows: [row(2, channel), row(3, channel)] })),
    });
    const started: string[] = [];
    const worker = (campaign: Campaign, mode: RunMode) => {
        started.push(campaign.id);
        const child = Object.assign(new EventEmitter(), { stderr: null, kill: () => true }) as unknown as ChildProcess;
        const outcome = outcomes.shift() ?? 'complete';
        if (outcome === 'hang') {
            store[mode](campaign.id);
            Object.assign(child, { kill: () => queueMicrotask(() => { store.pause(campaign.id); child.emit('close', 0); }) });
            return child;
        }
        queueMicrotask(() => {
            store[mode](campaign.id);
            if (outcome === 'complete') {
                db.prepare("UPDATE messages SET status = 'SENT' WHERE campaign_id = ? AND status = 'QUEUED'").run(campaign.id);
                store.settleCampaign(campaign.id);
            } else {
                store.pause(campaign.id);
            }
            child.emit('close', outcome === 'crash' ? 1 : 0);
        });
        return child;
    };
    const directory = mkdtempSync(join(tmpdir(), 'message-blaster-runner-'));
    context.after(() => rmSync(directory, { recursive: true, force: true }));
    const databaseFile = join(directory, 'app.db');
    writeFileSync(databaseFile, '');
    const settings = () => ({ ...loadEnv(), ...DEFAULT_SETTINGS, DATABASE_URL: databaseFile, DRY_RUN: false }) as Environment;
    const runner = new WebRunner(store, settings, () => {}, worker);
    const audit = { record: () => {}, mutation: (_: string, operation: () => unknown) => operation() } as unknown as RequestAudit;
    const group = store.campaignGroup('launch');
    const steps: LaunchStep[] = [
        { id: 'launch-gmail', channel: 'gmail', mode: 'start' },
        { id: 'launch-whatsapp', channel: 'whatsapp', mode: 'start' },
    ];
    return { store, runner, audit, group, steps, started };
}

function sendBoth(group: CampaignGroup, steps: LaunchStep[], approve: string, audit: RequestAudit) {
    return { group, steps, approve, audit, approval: group.slug, action: 'campaign.send' };
}

async function settled() {
    for (let turn = 0; turn < 20; turn += 1) await setImmediate();
}

test('Send both runs the second channel only after the first completes', async context => {
    const { store, runner, audit, group, steps, started } = setup(context, ['complete', 'complete']);
    assert.throws(() => runner.launch(sendBoth(group, steps, 'wrong', audit)), /approval/iu);
    assert.deepEqual(started, [], 'nothing starts without approval');

    runner.launch(sendBoth(group, steps, 'launch', audit));
    assert.deepEqual(store.campaignGroup('launch').pendingChannels, ['whatsapp']);
    assert.ok(runner.continuing(group));
    assert.throws(() => runner.launch(sendBoth(group, steps, 'launch', audit)), /sending/u, 'a double click cannot start it twice');
    await settled();
    assert.deepEqual(started, ['launch-gmail', 'launch-whatsapp']);
    assert.deepEqual(store.campaignGroup('launch').pendingChannels, []);
    assert.equal(store.getCampaign('launch-whatsapp').state, 'Completed');
    assert.equal(runner.continuing(group), false);
});

test('a paused or failed first channel leaves the second waiting for an explicit resume', async context => {
    for (const outcome of ['pause', 'crash'] as const) {
        const { store, runner, audit, group, steps, started } = setup(context, [outcome]);
        runner.launch(sendBoth(group, steps, 'launch', audit));
        await settled();
        assert.deepEqual(started, ['launch-gmail'], `${outcome}: the second channel does not start`);
        assert.deepEqual(store.campaignGroup('launch').pendingChannels, ['whatsapp'], `${outcome}: it is still pending`);
        assert.equal(runner.continuing(group), false, `${outcome}: nothing will start it automatically`);
        assert.equal(store.getCampaign('launch-whatsapp').state, 'Ready');
    }
});

test('preflight refuses the whole send when any selected channel cannot start', context => {
    const { store, runner, audit, group, steps, started } = setup(context, []);
    store.cancel('launch-whatsapp');
    assert.throws(() => runner.launch(sendBoth(group, steps, 'launch', audit)), /Cannot start/u);
    assert.deepEqual(started, []);
    assert.deepEqual(store.campaignGroup('launch').pendingChannels, []);
    assert.equal(store.getCampaign('launch-gmail').state, 'Ready');
});

test('a server shutdown mid-send flags the paused campaign; a user pause does not', async context => {
    const shutdown = setup(context, ['hang']);
    shutdown.runner.launch(sendBoth(shutdown.group, shutdown.steps, 'launch', shutdown.audit));
    await shutdown.runner.close();
    const stopped = shutdown.store.getCampaign('launch-gmail');
    assert.equal(stopped.state, 'Paused');
    assert.ok(stopped.interruptedAt);
    assert.equal(shutdown.runner.decorate(stopped).runError, INTERRUPTED_NOTICE);

    const paused = setup(context, ['hang']);
    paused.runner.launch(sendBoth(paused.group, paused.steps, 'launch', paused.audit));
    paused.runner.pause('launch-gmail', paused.audit);
    await paused.runner.close();
    const byUser = paused.store.getCampaign('launch-gmail');
    assert.equal(byUser.state, 'Paused');
    assert.equal(byUser.interruptedAt, null);
    assert.equal(paused.runner.decorate(byUser).runError, undefined);
});
