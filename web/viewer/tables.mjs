import { element } from '../shared/ui.mjs';

export const MAX_ROWS = 500;
export const MAX_COLUMNS = 40;

export function table(rows) {
    const body = element('tbody');
    for (const [index, values] of rows.slice(0, MAX_ROWS).entries()) body.append(tableRow(values, index === 0 ? 'th' : 'td'));
    const node = element('table');
    node.append(body);
    const wrap = element('div', 'viewer-table');
    wrap.append(node);
    return wrap;
}

export function parseCsv(text) {
    const parser = { rows: [], row: [], cell: '', quoted: false };
    for (let index = 0; index < text.length && parser.rows.length < MAX_ROWS; index++) index = readCharacter(parser, text, index);
    if (parser.cell || parser.row.length) parser.rows.push([...parser.row, parser.cell]);
    return parser.rows;
}

function tableRow(values, cellTag) {
    const row = element('tr');
    for (const value of values.slice(0, MAX_COLUMNS)) row.append(element(cellTag, '', value));
    return row;
}

function readCharacter(parser, text, index) {
    const character = text[index];
    if (parser.quoted) return readQuoted(parser, text, index);
    if (character === '"') parser.quoted = true;
    else if (character === ',') endCell(parser);
    else if (character === '\n' || character === '\r') return endRow(parser, text, index);
    else parser.cell += character;
    return index;
}

function readQuoted(parser, text, index) {
    const character = text[index];
    if (character === '"' && text[index + 1] === '"') {
        parser.cell += '"';
        return index + 1;
    }
    if (character === '"') parser.quoted = false;
    else parser.cell += character;
    return index;
}

function endCell(parser) {
    parser.row.push(parser.cell);
    parser.cell = '';
}

function endRow(parser, text, index) {
    endCell(parser);
    parser.rows.push(parser.row);
    parser.row = [];
    return text[index] === '\r' && text[index + 1] === '\n' ? index + 1 : index;
}
