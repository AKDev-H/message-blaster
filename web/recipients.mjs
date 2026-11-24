import { icon } from './icons.mjs';
import { element, get, number } from './ui.mjs';

export const MAX_TYPED_RECIPIENTS = 500;

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const phonePattern = /^\+?[\d\s().-]+$/u;
const columnInfo = {
    name: { label: 'Name', placeholder: 'Ari Tan', type: 'text', width: 'minmax(0, 1fr)' },
    email: { label: 'Email', placeholder: 'ari@example.com', type: 'email', width: 'minmax(0, 1.25fr)' },
    phone: { label: 'Phone', placeholder: '+60 12 345 6789', type: 'tel', width: 'minmax(0, 1fr)' },
};

const blank = () => ({ name: '', email: '', phone: '' });
const isFilled = row => Object.values(row).some(value => value.trim());
const isPhone = value => phonePattern.test(value) && value.replaceAll(/\D/gu, '').length >= 6;

export function createRecipientList(channels, notify) {
    const table = get('recipient-table');
    const list = get('recipient-rows');
    const consent = get('recipient-consent');
    const addButton = get('recipient-add');
    let rows = [blank(), blank()];

    const columns = () => {
        const selected = channels();
        return ['name', ...(selected.includes('gmail') ? ['email'] : []), ...(selected.includes('whatsapp') ? ['phone'] : [])];
    };
    const filled = () => rows.filter(isFilled);
    const changed = () => table.dispatchEvent(new Event('input'));
    const cell = (index, key) => list.querySelector(`[data-row="${index}"] [data-key="${key}"]`);
    const position = target => {
        const row = target.closest('[data-row]');
        return row ? { index: Number(row.dataset.row), key: target.dataset.key } : null;
    };

    function focusCell(index, key) {
        const input = cell(index, key);
        input?.focus();
        input?.scrollIntoView({ block: 'nearest' });
    }

    function updateCount() {
        const total = filled().length;
        get('recipient-count').textContent = total ? `${number.format(total)} ${total === 1 ? 'recipient' : 'recipients'}` : '';
    }

    function renderRow(row, index, keys, entering) {
        const node = element('div', entering ? 'recipient-row entering' : 'recipient-row');
        node.dataset.row = String(index);
        for (const key of keys) {
            const { label, placeholder, type } = columnInfo[key];
            const input = element('input', 'recipient-input');
            Object.assign(input, { type, value: row[key], placeholder, autocomplete: 'off', spellcheck: false });
            input.dataset.key = key;
            input.setAttribute('aria-label', `${label}, row ${index + 1}`);
            node.append(input);
        }
        const remove = element('button', 'icon-button');
        remove.type = 'button';
        remove.title = 'Remove';
        remove.dataset.remove = '';
        remove.setAttribute('aria-label', `Remove row ${index + 1}`);
        remove.append(icon('x', 14));
        node.append(remove);
        return node;
    }

    function render(entering = -1) {
        const keys = columns();
        table.style.setProperty('--recipient-columns', keys.map(key => columnInfo[key].width).join(' '));
        get('recipient-head').replaceChildren(...keys.map(key => element('span', '', columnInfo[key].label)), element('span'));
        list.replaceChildren(...rows.map((row, index) => renderRow(row, index, keys, index === entering)));
        addButton.disabled = rows.length >= MAX_TYPED_RECIPIENTS;
        updateCount();
    }

    function addRow() {
        if (rows.length >= MAX_TYPED_RECIPIENTS) return;
        rows.push(blank());
        render(rows.length - 1);
        focusCell(rows.length - 1, columns()[0]);
    }

    function removeRow(index) {
        if (rows.length === 1) rows[0] = blank();
        else rows.splice(index, 1);
        render();
        focusCell(Math.min(index, rows.length - 1), columns()[0]);
        changed();
    }

    function paste(event, { index, key }) {
        const text = event.clipboardData?.getData('text/plain') ?? '';
        if (!/[\t\n]/u.test(text.trim())) return;
        event.preventDefault();
        const visible = columns();
        const keys = visible.slice(visible.indexOf(key));
        const lines = text.replaceAll('\r', '').split('\n').filter(line => line.trim());
        const room = MAX_TYPED_RECIPIENTS - index;
        for (const [offset, line] of lines.slice(0, room).entries()) {
            rows[index + offset] ??= blank();
            for (const [column, value] of line.split('\t').entries()) {
                if (keys[column]) rows[index + offset][keys[column]] = value.trim();
            }
        }
        render();
        focusCell(index + Math.min(lines.length, room) - 1, key);
        changed();
        if (lines.length > room) notify(`Only the first ${number.format(MAX_TYPED_RECIPIENTS)} rows fit. Upload a workbook for more.`);
    }

    function problem(editing) {
        const keys = columns();
        if (!filled().length) return editing ? null : { message: 'Add at least one recipient.', index: 0, key: keys[0] };
        const wantsEmail = keys.includes('email');
        const wantsPhone = keys.includes('phone');
        for (const [index, row] of rows.entries()) {
            if (!isFilled(row)) continue;
            const at = (key, message) => ({ message: `Row ${index + 1}: ${message}`, index, key });
            const email = row.email.trim();
            const phone = row.phone.trim();
            if (!row.name.trim()) return at('name', 'enter a name.');
            if (wantsEmail && wantsPhone && !email && !phone) return at('email', 'enter an email address or phone number.');
            if (wantsEmail && !wantsPhone && !email) return at('email', 'enter an email address.');
            if (wantsPhone && !wantsEmail && !phone) return at('phone', 'enter a phone number.');
            if (wantsEmail && email && !emailPattern.test(email)) return at('email', 'check the email address.');
            if (wantsPhone && phone && !isPhone(phone)) return at('phone', 'check the phone number.');
        }
        if (!consent.checked) return { message: 'Confirm that everyone listed agreed to receive messages.' };
        return null;
    }

    list.addEventListener('input', ({ target }) => {
        const at = position(target);
        if (!at?.key) return;
        rows[at.index][at.key] = target.value;
        target.removeAttribute('aria-invalid');
        updateCount();
    });
    list.addEventListener('paste', event => {
        const at = position(event.target);
        if (at?.key) paste(event, at);
    });
    list.addEventListener('keydown', event => {
        const at = position(event.target);
        if (!at?.key || event.key !== 'Enter' || event.isComposing) return;
        event.preventDefault();
        if (at.index === rows.length - 1) addRow();
        else focusCell(at.index + 1, at.key);
    });
    list.addEventListener('click', ({ target }) => {
        const remove = target.closest('[data-remove]');
        if (remove) removeRow(position(remove).index);
    });
    addButton.addEventListener('click', addRow);
    consent.addEventListener('change', changed);

    return {
        render,
        reset() {
            rows = [blank(), blank()];
            consent.checked = false;
            render();
        },
        error: editing => problem(editing)?.message ?? '',
        focusProblem(editing) {
            const found = problem(editing);
            if (!found) return;
            if (!found.key) {
                consent.focus();
                return;
            }
            cell(found.index, found.key)?.setAttribute('aria-invalid', 'true');
            focusCell(found.index, found.key);
        },
        hasEntries: () => filled().length > 0,
        payload() {
            const keys = columns();
            return JSON.stringify(filled().map(row => Object.fromEntries(keys.map(key => [key, row[key].trim()]))));
        },
    };
}
