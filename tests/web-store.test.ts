import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDatabase } from '../src/database/connection.js';
import { Store, type PreparedRow, type WebDraft } from '../src/store/index.js';

function row(rowNumber: number, overrides: Partial<PreparedRow> = {}): PreparedRow {
    return {
        rowNumber,
        clientName: `Client ${rowNumber}`,
        phone: `+6012345000${rowNumber}`,
        message: 'Hello',
        pdfFilename: '',
        consentStatus: 'Opted In',
        ...overrides,
    };
}

test('web drafts retain editable inputs, replace atomically and paginate the new snapshot', () => {
    using db = openDatabase(':memory:');
    const store = new Store(db);
    const draft: WebDraft = { workbook: Buffer.from('original workbook'), script: 'Original script', attachment: 'sample.pdf', subject: '' };
    store.importCampaign('draft', [row(1, { consentStatus: 'Not Opted In' })], false, 'whatsapp', draft);
    assert.equal(store.campaignSummary('draft').state, 'Draft');
    assert.equal(store.campaignSummary('draft').skipped, 1);
    assert.deepEqual(store.getWebDraft('draft'), draft);

    const updated = { ...draft, workbook: Buffer.from('replacement workbook'), script: 'New script' };
    assert.throws(() => store.replaceWebDraft('draft', [row(1), row(1)], updated), /UNIQUE constraint/);
    assert.deepEqual(store.getWebDraft('draft'), draft);
    assert.equal(store.campaignSummary('draft').skipped, 1);

    store.replaceWebDraft('draft', [row(3), row(2), row(4)], updated);
    const summary = store.campaignSummary('draft');
    assert.deepEqual(store.listGroupPage({ page: 1, pageSize: 10 }).groups.map(group => group.members), [[summary]]);
    assert.equal(summary.state, 'Ready');
    assert.equal(summary.total, 3);
    assert.equal(summary.queued, 3);
    assert.equal(summary.skipped, 0);
    assert.equal(store.getWebDraftSettings('draft')?.script, 'New script');
    const result = store.listMessagePage('draft', 2, 2);
    assert.deepEqual(result.rows.map(message => message.rowNumber), [4]);
    assert.equal(result.page, 2);
    assert.equal(result.totalPages, 2);
    store.bindAccount('draft', 'account');
    assert.throws(() => store.replaceWebDraft('draft', [row(5)], updated), /never started/);
});

test('retry and delete preserve consent, protect active attempts, and update summaries', () => {
    using db = openDatabase(':memory:');
    const store = new Store(db);
    store.importCampaign('campaign', [row(1), row(2), row(3), row(4)]);
    store.bindAccount('campaign', 'account');
    store.start('campaign');
    const [failed, optedOut, unknown, completed] = store.listMessages('campaign');
    assert.ok(failed && optedOut && unknown && completed);
    assert.ok(store.claim('campaign', failed.id, 'failed-id'));
    assert.equal(store.campaignSummary('campaign').processing, 1);
    assert.throws(() => store.deleteCampaign('campaign'), /in-flight/);
    store.pause('campaign');
    assert.throws(() => store.retryFailed('campaign'), /in-flight/);
    store.finish(failed.id, 'FAILED');
    store.resume('campaign');
    assert.ok(store.claim('campaign', optedOut.id, 'opted-out-id'));
    assert.ok(store.claim('campaign', unknown.id, 'unknown-id'));
    assert.ok(store.claim('campaign', completed.id, 'completed-id'));
    store.finish(optedOut.id, 'FAILED');
    store.finish(unknown.id, 'UNKNOWN');
    store.receipt('completed-id', 'DELIVERED');
    store.pause('campaign');
    assert.throws(() => store.deleteCampaign('campaign'), /in-flight/);
    store.finish(completed.id, 'SENT');
    store.settleCampaign('campaign');
    store.withdraw(optedOut.phone);

    assert.throws(() => store.review(unknown.id, 'FAILED', 'Verified failed elsewhere', 'another-campaign'), /unknown outcomes/);
    assert.equal(store.retryFailed('campaign'), 1);
    assert.equal(store.getCampaign('campaign').accountId, 'account');
    const { state, total, queued, processing, completed: sent, failed: stillFailed, unknown: stillUnknown } = store.campaignSummary('campaign');
    assert.deepEqual({ state, total, queued, processing, sent, stillFailed, stillUnknown },
        { state: 'Paused', total: 4, queued: 1, processing: 0, sent: 1, stillFailed: 1, stillUnknown: 1 });
    assert.equal(store.attempts(failed.id)[0]?.state, 'FAILED');

    store.deleteCampaign('campaign');
    assert.deepEqual(store.listGroupPage({ page: 1, pageSize: 10 }).groups, [], 'the campaign page goes with its last channel');
    assert.deepEqual(store.attempts(failed.id), []);
    assert.equal(store.isWithdrawn(optedOut.phone), true);
});
