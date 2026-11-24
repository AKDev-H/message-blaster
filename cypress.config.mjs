import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { defineConfig } from 'cypress';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';

const storage = resolve('storage/cypress');
const databasePath = join(storage, 'cypress.db');
const attachments = join(storage, 'attachments');
const fixtures = join(storage, 'fixtures');

async function resetDatabase() {
    const db = new DatabaseSync(databasePath);
    try {
        db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE');
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
        for (const { name } of tables) db.exec(`DELETE FROM "${String(name).replaceAll('"', '""')}"`);
        db.exec('COMMIT; PRAGMA foreign_keys = ON');
    } finally {
        db.close();
    }
    await mkdir(attachments, { recursive: true });
    for (const name of await readdir(attachments)) await rm(join(attachments, name), { recursive: true, force: true });
    return null;
}

const headers = {
    gmail: ['Client Name', 'Email Address', 'Subject', 'Message', 'PDF Filename', 'Consent Status', 'Campaign ID'],
    whatsapp: ['Client Name', 'Phone Number', 'Message', 'PDF Filename', 'Consent Status', 'Campaign ID'],
    both: ['Client Name', 'Email Address', 'Phone Number', 'Subject', 'Message', 'PDF Filename', 'Consent Status', 'Campaign ID'],
};

async function createWorkbook({ name, channel, rows }) {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Clients');
    sheet.addRow(headers[channel]);
    for (const row of rows) sheet.addRow(headers[channel].map(header => row[header] ?? ''));
    await mkdir(fixtures, { recursive: true });
    const path = join(fixtures, `${name}.xlsx`);
    await workbook.xlsx.writeFile(path);
    return path;
}

async function createDocx({ name, heading, paragraph }) {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    zip.file('word/document.xml', '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
    + `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${heading}</w:t></w:r></w:p>`
    + `<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>${paragraph}</w:t></w:r></w:p></w:body></w:document>`);
    await mkdir(fixtures, { recursive: true });
    const path = join(fixtures, `${name}.docx`);
    await writeFile(path, await zip.generateAsync({ type: 'nodebuffer' }));
    return path;
}

async function inspectWorkbook(base64) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(base64, 'base64'));
    const sheet = workbook.worksheets[0];
    return { headers: sheet.getRow(1).values.filter(Boolean), rows: sheet.actualRowCount };
}

export default defineConfig({
    e2e: {
        baseUrl: 'http://127.0.0.1:4319',
        specPattern: 'cypress/e2e/**/*.cy.js',
        supportFile: 'cypress/support/e2e.js',
        viewportWidth: 1360,
        viewportHeight: 900,
        video: false,
        screenshotsFolder: 'storage/cypress/screenshots',
        downloadsFolder: 'storage/cypress/downloads',
        setupNodeEvents(on) {
            on('task', { 'db:reset': resetDatabase, 'workbook:create': createWorkbook, 'docx:create': createDocx, 'workbook:inspect': inspectWorkbook });
        },
    },
});
