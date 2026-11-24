import { icon } from '../../shared/icons.mjs';
import { element } from '../../shared/ui.mjs';

export const MAX_TYPED_RECIPIENTS = 500;

export const COLUMNS = {
    name: { label: 'Name', placeholder: 'Ari Tan', type: 'text', width: 'minmax(0, 1fr)' },
    email: { label: 'Email', placeholder: 'ari@example.com', type: 'email', width: 'minmax(0, 1.25fr)' },
    phone: { label: 'Phone', placeholder: '+60 12 345 6789', type: 'tel', width: 'minmax(0, 1fr)' },
};

export const blankRow = () => ({ name: '', email: '', phone: '' });
export const isFilled = row => Object.values(row).some(value => value.trim());

export function columnsFor(channels) {
    return ['name', ...(channels.includes('gmail') ? ['email'] : []), ...(channels.includes('whatsapp') ? ['phone'] : [])];
}

export function rowElement(row, index, keys, entering) {
    const node = element('div', entering ? 'recipient-row entering' : 'recipient-row');
    node.dataset.row = String(index);
    node.append(...keys.map(key => cellInput(row, index, key)), removeButton(index));
    return node;
}

export function pasteRows(rows, text, { index, key }, visibleKeys) {
    const keys = visibleKeys.slice(visibleKeys.indexOf(key));
    const lines = text.replaceAll('\r', '').split('\n').filter(line => line.trim());
    const room = MAX_TYPED_RECIPIENTS - index;
    for (const [offset, line] of lines.slice(0, room).entries()) fillRow(rows, index + offset, keys, line);
    return { pasted: Math.min(lines.length, room), overflow: lines.length > room };
}

function fillRow(rows, index, keys, line) {
    rows[index] ??= blankRow();
    for (const [column, value] of line.split('\t').entries()) {
        if (keys[column]) rows[index][keys[column]] = value.trim();
    }
}

function cellInput(row, index, key) {
    const { label, placeholder, type } = COLUMNS[key];
    const input = element('input', 'recipient-input');
    Object.assign(input, { type, value: row[key], placeholder, autocomplete: 'off', spellcheck: false });
    input.dataset.key = key;
    input.setAttribute('aria-label', `${label}, row ${index + 1}`);
    return input;
}

function removeButton(index) {
    const remove = element('button', 'icon-button');
    Object.assign(remove, { type: 'button', title: 'Remove' });
    remove.dataset.remove = '';
    remove.setAttribute('aria-label', `Remove row ${index + 1}`);
    remove.append(icon('x', 14));
    return remove;
}
