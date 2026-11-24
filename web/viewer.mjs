import { icon } from './icons.mjs';
import { element, get, number } from './ui.mjs';

const kinds = {
    pdf: ['pdf'],
    image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'],
    text: ['txt', 'md', 'json', 'log'],
    csv: ['csv'],
    docx: ['docx'],
    sheet: ['xlsx'],
};
const maxTextBytes = 512 * 1024;
const maxRows = 500;
const maxColumns = 40;

const extension = name => name.slice(name.lastIndexOf('.') + 1).toLowerCase();
const kindOf = name => Object.keys(kinds).find(kind => kinds[kind].includes(extension(name))) ?? 'none';
const fileUrl = name => `/api/attachments/${encodeURIComponent(name)}`;

const scripts = new Map();
function loadScript(src, globalName) {
    if (window[globalName]) return Promise.resolve(window[globalName]);
    if (!scripts.has(src)) {
        scripts.set(src, new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = src;
            script.onload = () => resolve(window[globalName]);
            script.onerror = () => {
                scripts.delete(src);
                reject(new Error('The document viewer could not load. Try again.'));
            };
            document.head.append(script);
        }));
    }
    return scripts.get(src);
}

async function fetchFile(name, as) {
    const response = await fetch(fileUrl(name));
    if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error || 'The file could not be opened.');
    }
    return as === 'text' ? response.text() : response.arrayBuffer();
}

const documentTags = new Set(['p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'sub', 'sup', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'blockquote', 'a', 'img']);

function appendSafeDocument(source, target) {
    for (const child of source.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
            target.append(child.data);
        } else if (child.nodeType === Node.ELEMENT_NODE) {
            const tag = child.localName;
            if (!documentTags.has(tag)) {
                appendSafeDocument(child, target);
                continue;
            }
            const node = document.createElement(tag === 'a' ? 'span' : tag);
            if (tag === 'img') {
                const src = child.getAttribute('src') ?? '';
                if (!/^data:image\/(png|jpe?g|gif|webp);base64,/iu.test(src)) continue;
                node.src = src;
                node.alt = child.getAttribute('alt') ?? '';
            }
            for (const name of ['colspan', 'rowspan']) {
                const value = Number(child.getAttribute(name));
                if (Number.isInteger(value) && value > 1 && value < 100) node.setAttribute(name, String(value));
            }
            appendSafeDocument(child, node);
            target.append(node);
        }
    }
}

function parseCsv(text) {
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;
    for (let index = 0; index < text.length && rows.length < maxRows; index++) {
        const character = text[index];
        if (quoted) {
            if (character === '"' && text[index + 1] === '"') {
                cell += '"';
                index++;
            } else if (character === '"') {
                quoted = false;
            } else {
                cell += character;
            }
        } else if (character === '"') {
            quoted = true;
        } else if (character === ',') {
            row.push(cell);
            cell = '';
        } else if (character === '\n' || character === '\r') {
            if (character === '\r' && text[index + 1] === '\n') index++;
            row.push(cell);
            rows.push(row);
            row = [];
            cell = '';
        } else {
            cell += character;
        }
    }
    if (cell || row.length) rows.push([...row, cell]);
    return rows;
}

function table(rows) {
    const wrap = element('div', 'viewer-table');
    const node = element('table');
    const body = element('tbody');
    for (const [index, values] of rows.slice(0, maxRows).entries()) {
        const tr = element('tr');
        for (const value of values.slice(0, maxColumns)) tr.append(element(index === 0 ? 'th' : 'td', '', value));
        body.append(tr);
    }
    node.append(body);
    wrap.append(node);
    return wrap;
}

const renderers = {
    pdf: name => {
        const frame = element('iframe', 'viewer-frame');
        frame.src = fileUrl(name);
        frame.title = name;
        return frame;
    },
    image: name => {
        const image = element('img', 'viewer-image');
        image.src = fileUrl(name);
        image.alt = name;
        return image;
    },
    async text(name) {
        const text = await fetchFile(name, 'text');
        return element('pre', 'viewer-text', text.length > maxTextBytes ? `${text.slice(0, maxTextBytes)}\n…` : text);
    },
    async csv(name) {
        return table(parseCsv(await fetchFile(name, 'text')));
    },
    async docx(name) {
        const [mammoth, arrayBuffer] = await Promise.all([loadScript('/vendor/mammoth.js', 'mammoth'), fetchFile(name)]);
        const { value } = await mammoth.convertToHtml({ arrayBuffer });
        const template = document.createElement('template');
        template.innerHTML = value;
        const page = element('article', 'viewer-document');
        appendSafeDocument(template.content, page);
        if (!page.textContent.trim() && !page.querySelector('img')) page.append(element('p', 'muted', 'This document is empty.'));
        return page;
    },
    async sheet(name) {
        const [ExcelJS, buffer] = await Promise.all([loadScript('/vendor/exceljs.js', 'ExcelJS'), fetchFile(name)]);
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(buffer);
        const sheets = workbook.worksheets.map(sheet => {
            const rows = [];
            sheet.eachRow({ includeEmpty: false }, row => {
                if (rows.length >= maxRows) return;
                const values = [];
                for (let column = 1; column <= Math.min(sheet.columnCount, maxColumns); column++) values.push(row.getCell(column).text);
                rows.push(values);
            });
            return { name: sheet.name, rows };
        });
        if (!sheets.length) return element('p', 'viewer-empty', 'This workbook has no sheets.');
        const wrap = element('div', 'viewer-sheets');
        const tabs = element('div', 'viewer-tabs');
        tabs.setAttribute('role', 'tablist');
        const show = index => {
            for (const [tabIndex, tab] of [...tabs.children].entries()) tab.setAttribute('aria-selected', String(tabIndex === index));
            wrap.lastElementChild.replaceWith(sheets[index].rows.length ? table(sheets[index].rows) : element('p', 'viewer-empty', 'This sheet is empty.'));
        };
        for (const [index, sheet] of sheets.entries()) {
            const tab = element('button', 'viewer-tab', sheet.name);
            tab.type = 'button';
            tab.setAttribute('role', 'tab');
            tab.addEventListener('click', () => show(index));
            tabs.append(tab);
        }
        wrap.append(...(sheets.length > 1 ? [tabs] : []), element('div'));
        show(0);
        return wrap;
    },
    none(name) {
        const empty = element('div', 'viewer-empty');
        empty.append(icon('file', 28), element('strong', '', `No preview for .${extension(name)} files`),
            element('span', '', 'Download the file to open it.'));
        return empty;
    },
};

export function createViewer() {
    const dialog = get('viewer');
    const body = get('viewer-body');
    let current = 0;

    async function open(name, size) {
        const request = ++current;
        get('viewer-title').textContent = name;
        get('viewer-meta').textContent = size === undefined ? '' : `${number.format(Math.ceil(size / 1024))} KB`;
        get('viewer-download').href = `${fileUrl(name)}?download`;
        body.dataset.kind = kindOf(name);
        body.replaceChildren(element('p', 'viewer-loading', 'Opening…'));
        if (!dialog.open) dialog.showModal();
        try {
            const content = await renderers[kindOf(name)](name);
            if (request === current) body.replaceChildren(content);
        } catch (error) {
            if (request !== current) return;
            const failure = renderers.none(name);
            failure.querySelector('strong').textContent = error.message || 'The file could not be opened.';
            body.replaceChildren(failure);
        }
    }

    dialog.addEventListener('close', () => {
        current++;
        body.replaceChildren();
    });
    return { open };
}
