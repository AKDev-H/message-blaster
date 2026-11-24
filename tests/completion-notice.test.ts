import assert from 'node:assert/strict';
import { test } from 'node:test';
import { completionNotice } from '../src/services/campaign/completion-notice.js';
import type { CampaignSummary } from '../src/store/index.js';

const summary = (overrides: Partial<CampaignSummary> = {}): CampaignSummary => ({
    id: 'spring-sale-whatsapp', state: 'Completed', createdAt: '', updatedAt: '', isTest: false, channel: 'whatsapp', interruptedAt: null,
    total: 10, queued: 0, processing: 0, completed: 8, failed: 2, unknown: 0, skipped: 0, ...overrides,
});

test('a finished campaign produces a WhatsApp summary with the totals', () => {
    assert.equal(completionNotice(summary(), 'Spring sale'), [
        '✅ Campaign finished successfully', '', 'Campaign: Spring sale', 'Channel: WhatsApp',
        'Total people: 10', 'Sent successfully: 8', 'Failed: 2',
    ].join('\n'));
});

test('review and skipped counts appear only when present', () => {
    const text = completionNotice(summary({ channel: 'gmail', unknown: 1, skipped: 3 }))!;
    assert.match(text, /Campaign: spring-sale-whatsapp\nChannel: Gmail/);
    assert.match(text, /Needs review: 1\nSkipped: 3$/);
});

test('a campaign where nothing was sent says so', () => {
    assert.match(completionNotice(summary({ state: 'Failed', completed: 0, failed: 10 }))!, /^❌ Campaign finished — nothing could be sent/);
});

test('paused, running and test campaigns send no summary', () => {
    for (const state of ['Paused', 'Running', 'Cancelled'] as const) assert.equal(completionNotice(summary({ state })), undefined);
    assert.equal(completionNotice(summary({ isTest: true })), undefined);
});
