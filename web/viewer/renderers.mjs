import { icon } from '../shared/icons.mjs';
import { extensionOf } from '../shared/labels.mjs';
import { element } from '../shared/ui.mjs';
import { fetchFile, fileUrl, loadScript } from './files.mjs';
import { appendSafeDocument } from './safe-document.mjs';
import { MAX_COLUMNS, MAX_ROWS, parseCsv, table } from './tables.mjs';

const MAX_TEXT_LENGTH = 512 * 1024;

export const RENDERERS = {
    pdf: name => Object.assign(element('iframe', 'viewer-frame'), { src: fileUrl(name), title: name }),
    image: name => Object.assign(element('img', 'viewer-image'), { src: fileUrl(name), alt: name }),
    text: renderText,
    csv: async name => table(parseCsv(await fetchFile(name, 'text'))),
    docx: renderWordDocument,
    sheet: renderWorkbook,
    none: renderNoPreview,
};

async function renderText(name) {
    const text = await fetchFile(name, 'text');
    return element('pre', 'viewer-text', text.length > MAX_TEXT_LENGTH ? `${text.slice(0, MAX_TEXT_LENGTH)}\n…` : text);
}

async function renderWordDocument(name) {
    const [mammoth, arrayBuffer] = await Promise.all([loadScript('/vendor/mammoth.js', 'mammoth'), fetchFile(name)]);
    const template = document.createElement('template');
    template.innerHTML = (await mammoth.convertToHtml({ arrayBuffer })).value;
    const page = element('article', 'viewer-document');
    appendSafeDocument(template.content, page);
    if (!page.textContent.trim() && !page.querySelector('img')) page.append(element('p', 'muted', 'This document is empty.'));
    return page;
}

async function renderWorkbook(name) {
    const [ExcelJS, buffer] = await Promise.all([loadScript('/vendor/exceljs.js', 'ExcelJS'), fetchFile(name)]);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const sheets = workbook.worksheets.map(readSheet);
    return sheets.length ? sheetTabs(sheets) : element('p', 'viewer-empty', 'This workbook has no sheets.');
}

function renderNoPreview(name) {
    const empty = element('div', 'viewer-empty');
    empty.append(icon('file', 28), element('strong', '', `No preview for .${extensionOf(name)} files`), element('span', '', 'Download the file to open it.'));
    return empty;
}

function readSheet(sheet) {
    const rows = [];
    const columns = Math.min(sheet.columnCount, MAX_COLUMNS);
    sheet.eachRow({ includeEmpty: false }, row => {
        if (rows.length < MAX_ROWS) rows.push(Array.from({ length: columns }, (_, index) => row.getCell(index + 1).text));
    });
    return { name: sheet.name, rows };
}

function sheetTabs(sheets) {
    const wrap = element('div', 'viewer-sheets');
    const tabs = element('div', 'viewer-tabs');
    tabs.setAttribute('role', 'tablist');
    const show = index => showSheet(wrap, tabs, sheets[index], index);
    tabs.append(...sheets.map((sheet, index) => sheetTab(sheet.name, () => show(index))));
    wrap.append(...(sheets.length > 1 ? [tabs] : []), element('div'));
    show(0);
    return wrap;
}

function sheetTab(name, onClick) {
    const tab = element('button', 'viewer-tab', name);
    tab.type = 'button';
    tab.setAttribute('role', 'tab');
    tab.addEventListener('click', onClick);
    return tab;
}

function showSheet(wrap, tabs, sheet, index) {
    for (const [tabIndex, tab] of [...tabs.children].entries()) tab.setAttribute('aria-selected', String(tabIndex === index));
    wrap.lastElementChild.replaceWith(sheet.rows.length ? table(sheet.rows) : element('p', 'viewer-empty', 'This sheet is empty.'));
}
