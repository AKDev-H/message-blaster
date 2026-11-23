import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import ExcelJS from 'exceljs';
import { AttachmentError, readAttachment } from '../src/services/attachment.service.js';
import { generateExcel, readExcel, writeExcel } from '../src/services/excel.service.js';
import { normalizePhone } from '../src/utils/phone.util.js';
import { renderTemplate } from '../src/utils/template.util.js';

async function workspace(t: TestContext): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'whatsapp-input-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    return directory;
}

test('normalizes local and international phone numbers with the configured country', () => {
    assert.equal(normalizePhone('012-345 6789', 'MY'), '+60123456789');
    assert.equal(normalizePhone('+60 12-345 6789', 'SG'), '+60123456789');
    assert.equal(normalizePhone('202-555-0101', 'US'), '+12025550101');
    assert.throws(() => normalizePhone('call +1 202 555 0101', 'MY'), /Invalid phone/);
    assert.throws(() => normalizePhone('+1 202 555 0101 ext 9', 'MY'), /Invalid phone/);
    assert.throws(() => normalizePhone('123', 'MY'), /Invalid phone/);
});

test('renders placeholders without evaluating their values', () => {
    assert.equal(renderTemplate('Dear {{ client_name }},\nID {{client_id}}', {
        client_name: 'Aisyah {{family}}',
        client_id: '0042',
    }), 'Dear Aisyah {{family}},\nID 0042');
    assert.throws(() => renderTemplate('{{constructor}}', {}), /Unknown message placeholder/);
    assert.throws(() => renderTemplate('{{client-name}}', {}), /Malformed message placeholder/);
    assert.throws(() => renderTemplate('{{client_name', {}), /Malformed message placeholder/);
});

test('generates a private, opt-out sample template without overwriting it', async (t) => {
    const directory = await workspace(t);
    const path = join(directory, 'clients.xlsx');
    assert.equal(await generateExcel(path), true);
    const initial = await readFile(path);
    assert.equal(await generateExcel(path), false);
    assert.deepEqual(await readFile(path), initial);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(path);
    assert.deepEqual(workbook.worksheets[0]?.getRow(1).values, [
        // eslint-disable-next-line no-sparse-arrays -- ExcelJS returns one-based row values.
        , 'Client ID', 'Client Name', 'Phone Number', 'Message', 'PDF Filename', 'Consent Status',
        'Campaign ID', 'Sending Status', 'WhatsApp Message ID', 'Sent At', 'Error Message', 'Retry Count',
    ]);
    const [sample] = await readExcel(path);
    assert.equal(sample?.consentStatus, 'Not Opted In');
    assert.equal(sample?.phone, '+12025550101');
});

test('imports 5,000 contact rows, preserves text identifiers and flags formula cells', async (t) => {
    const directory = await workspace(t);
    const path = join(directory, 'import.xlsx');
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Clients');
    sheet.addRow(['Consent Status', 'Phone Number', 'Client Name', 'Message', 'PDF Filename', 'Campaign ID', 'Client ID']);
    for (let index = 0; index < 5_000; index++) {
        const phone = index === 0 ? { formula: '"0123456789"', result: '0123456789' } : '0123456789';
        sheet.addRow(['Opted In', phone, 'Example Client', 'First line\nSecond line', '', 'demo', `000${index}`]);
    }
    sheet.getRow(6000).getCell(8).value = 'Ignored metadata';
    await workbook.xlsx.writeFile(path);
    const rows = await readExcel(path);
    assert.equal(rows.length, 5_000);
    assert.match(rows[0]?.error ?? '', /Phone Number.*without formulas/);
    assert.equal(rows[1]?.phone, '0123456789');
    assert.equal(rows[1]?.clientId, '0001');
    assert.equal(rows[1]?.message, 'First line\nSecond line');
    assert.equal(rows.at(-1)?.pdfFilename, '');

    sheet.getRow(6001).getCell(7).value = 'too many';
    await workbook.xlsx.writeFile(path);
    await assert.rejects(readExcel(path), /at most 5000 contact rows/);
});

test('exports receipt timestamps and keeps message content as text', async (t) => {
    const directory = await workspace(t);
    const path = join(directory, 'results.xlsx');
    await writeExcel(path, [{
        clientId: '0042',
        clientName: 'Example Client',
        phone: '+12025550101',
        message: '=1+1',
        pdfFilename: '',
        consentStatus: 'Opted In',
        campaignId: 'demo',
        sendingStatus: 'READ',
        retryCount: 1,
        sentAt: '2026-11-23T00:00:00.000Z',
        serverAcknowledgedAt: '2026-11-23T00:00:01.000Z',
        deliveredAt: '2026-11-23T00:00:02.000Z',
        readAt: '2026-11-23T00:00:03.000Z',
    }]);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(path);
    const sheet = workbook.getWorksheet('Results');
    assert.equal(sheet?.getCell('D2').value, '=1+1');
    assert.equal(sheet?.getCell('M1').value, 'Server Acknowledged At');
    assert.deepEqual(sheet?.getCell('M2').value, new Date('2026-11-23T00:00:01.000Z'));
    assert.deepEqual(sheet?.getCell('N2').value, new Date('2026-11-23T00:00:02.000Z'));
    assert.deepEqual(sheet?.getCell('O2').value, new Date('2026-11-23T00:00:03.000Z'));
    await assert.rejects(writeExcel(path, []), /already exists/);
});

test('reads sample PDFs and rejects traversal, symlinks, missing and corrupted files', async (t) => {
    for (const name of ['sample-invoice.pdf', 'sample-contract.pdf', 'sample-document.pdf']) {
        const attachment = await readAttachment(resolve('tests/fixtures'), name);
        assert.equal(attachment.name, name);
        assert.match(attachment.sha256, /^[a-z0-9]{64}$/);
        assert.equal(attachment.data.subarray(0, 5).toString(), '%PDF-');
    }

    const directory = await workspace(t);
    await writeFile(join(directory, 'corrupt.pdf'), '%PDF-1.7\nhello\n%%EOF');
    await symlink(resolve('tests/fixtures/sample-document.pdf'), join(directory, 'linked.pdf'));
    for (const name of ['../outside.pdf', 'folder\\outside.pdf', 'linked.pdf', 'C:invoice.pdf']) {
        await assert.rejects(
            readAttachment(directory, name),
            (error) => error instanceof AttachmentError && error.code === 'UNSAFE_PATH',
        );
    }
    await assert.rejects(
        readAttachment(directory, 'missing.pdf'),
        (error) => error instanceof AttachmentError && error.code === 'MISSING_ATTACHMENT',
    );
    await assert.rejects(
        readAttachment(directory, 'corrupt.pdf'),
        (error) => error instanceof AttachmentError && error.code === 'INVALID_PDF',
    );
});
