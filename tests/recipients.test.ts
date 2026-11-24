import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readExcel } from '../src/services/excel/read.js';
import { HttpError } from '../src/web/http-error.js';
import { readDraft } from '../src/web/input/index.js';

function form(entries: Record<string, string>) {
    const data = new FormData();
    for (const [key, value] of Object.entries(entries)) data.set(key, value);
    return data;
}

test('typed recipients become an opted-in workbook for either channel', async () => {
    const recipients = JSON.stringify([
        { name: ' Ari ', email: 'ari@example.com', phone: '+60123456789' },
        { name: '', email: '', phone: '' },
        { name: 'Ben', phone: '0123456780' },
    ]);
    const draft = await readDraft(form({ recipients, recipientsConsent: 'yes', script: 'Hi' }));
    assert.equal(draft.source, 'recipients');
    const whatsapp = await readExcel(draft.workbook, 'whatsapp');
    assert.deepEqual(whatsapp.map(({ clientName, phone, consentStatus }) => [clientName, phone, consentStatus]), [
        ['Ari', '+60123456789', 'Opted In'],
        ['Ben', '0123456780', 'Opted In'],
    ]);
    const gmail = await readExcel(draft.workbook, 'gmail');
    assert.equal(gmail[0]?.email, 'ari@example.com');
    assert.equal(gmail[1]?.email, '');
});

test('typed recipients require consent and take priority over a stored workbook', async () => {
    const recipients = JSON.stringify([{ name: 'Ari', phone: '+60123456789' }]);
    await assert.rejects(readDraft(form({ recipients })), (error: HttpError) => error.field === 'recipients' && /agreed/.test(error.message));
    await assert.rejects(readDraft(form({ recipients: '{' })), (error: HttpError) => error.field === 'recipients');
    const previous = Buffer.from('previous');
    assert.equal((await readDraft(form({ recipients: '[]' }), previous)).workbook, previous);
    assert.notEqual((await readDraft(form({ recipients, recipientsConsent: 'yes' }), previous)).workbook, previous);
});

test('typed recipients reject malformed entries and oversized lists', async () => {
    const reject = (recipients: unknown, pattern: RegExp) => assert.rejects(
        readDraft(form({ recipients: JSON.stringify(recipients), recipientsConsent: 'yes' })),
        (error: HttpError) => error.field === 'recipients' && pattern.test(error.message),
    );
    await reject({ name: 'Ari' }, /could not be read/);
    await reject(['Ari'], /could not be read/);
    await reject([{ name: 42 }], /could not be read/);
    await reject([{ name: 'A'.repeat(256) }], /255 characters/);
    await reject(Array.from({ length: 501 }, (_, index) => ({ name: `R${index}`, phone: '+60123456789' })), /up to 500/);
});
