import { element, get, number } from '../../shared/ui.mjs';
import { firstProblem } from './rules.mjs';
import { blankRow, columnsFor, COLUMNS, isFilled, MAX_TYPED_RECIPIENTS, pasteRows, rowElement } from './rows.mjs';

export class RecipientList {
    #table = get('recipient-table');
    #list = get('recipient-rows');
    #consent = get('recipient-consent');
    #addButton = get('recipient-add');
    #rows = [blankRow(), blankRow()];

    constructor(channels, notify) {
        this.channels = channels;
        this.notify = notify;
        this.#listen();
    }

    render(entering = -1) {
        const keys = this.#columns();
        this.#table.style.setProperty('--recipient-columns', keys.map(key => COLUMNS[key].width).join(' '));
        get('recipient-head').replaceChildren(...keys.map(key => element('span', '', COLUMNS[key].label)), element('span'));
        this.#list.replaceChildren(...this.#rows.map((row, index) => rowElement(row, index, keys, index === entering)));
        this.#addButton.disabled = this.#rows.length >= MAX_TYPED_RECIPIENTS;
        this.#updateCount();
    }

    reset() {
        this.#rows = [blankRow(), blankRow()];
        this.#consent.checked = false;
        this.render();
    }

    error(editing) {
        return this.#problem(editing)?.message ?? '';
    }

    focusProblem(editing) {
        const found = this.#problem(editing);
        if (!found) return;
        if (!found.key) return this.#consent.focus();
        this.#cell(found.index, found.key)?.setAttribute('aria-invalid', 'true');
        this.#focusCell(found.index, found.key);
    }

    hasEntries() {
        return this.#filled().length > 0;
    }

    payload() {
        const keys = this.#columns();
        return JSON.stringify(this.#filled().map(row => Object.fromEntries(keys.map(key => [key, row[key].trim()]))));
    }

    #listen() {
        this.#list.addEventListener('input', ({ target }) => this.#onType(target));
        this.#list.addEventListener('paste', event => this.#onPaste(event));
        this.#list.addEventListener('keydown', event => this.#onKey(event));
        this.#list.addEventListener('click', ({ target }) => this.#onClick(target));
        this.#addButton.addEventListener('click', () => this.#addRow());
        this.#consent.addEventListener('change', () => this.#changed());
    }

    #onType(target) {
        const at = this.#position(target);
        if (!at?.key) return;
        this.#rows[at.index][at.key] = target.value;
        target.removeAttribute('aria-invalid');
        this.#updateCount();
    }

    #onPaste(event) {
        const at = this.#position(event.target);
        const text = event.clipboardData?.getData('text/plain') ?? '';
        if (!at?.key || !/[\t\n]/u.test(text.trim())) return;
        event.preventDefault();
        const { pasted, overflow } = pasteRows(this.#rows, text, at, this.#columns());
        this.render();
        this.#focusCell(at.index + pasted - 1, at.key);
        this.#changed();
        if (overflow) this.notify(`Only the first ${number.format(MAX_TYPED_RECIPIENTS)} rows fit. Upload a workbook for more.`);
    }

    #onKey(event) {
        const at = this.#position(event.target);
        if (!at?.key || event.key !== 'Enter' || event.isComposing) return;
        event.preventDefault();
        if (at.index === this.#rows.length - 1) this.#addRow();
        else this.#focusCell(at.index + 1, at.key);
    }

    #onClick(target) {
        const remove = target.closest('[data-remove]');
        if (remove) this.#removeRow(this.#position(remove).index);
    }

    #addRow() {
        if (this.#rows.length >= MAX_TYPED_RECIPIENTS) return;
        this.#rows.push(blankRow());
        this.render(this.#rows.length - 1);
        this.#focusCell(this.#rows.length - 1, this.#columns()[0]);
    }

    #removeRow(index) {
        if (this.#rows.length === 1) this.#rows[0] = blankRow();
        else this.#rows.splice(index, 1);
        this.render();
        this.#focusCell(Math.min(index, this.#rows.length - 1), this.#columns()[0]);
        this.#changed();
    }

    #problem(editing) {
        return firstProblem(this.#rows, this.#columns(), this.#consent.checked, editing);
    }

    #updateCount() {
        const total = this.#filled().length;
        get('recipient-count').textContent = total ? `${number.format(total)} ${total === 1 ? 'recipient' : 'recipients'}` : '';
    }

    #columns() {
        return columnsFor(this.channels());
    }

    #filled() {
        return this.#rows.filter(isFilled);
    }

    #changed() {
        this.#table.dispatchEvent(new Event('input'));
    }

    #cell(index, key) {
        return this.#list.querySelector(`[data-row="${index}"] [data-key="${key}"]`);
    }

    #focusCell(index, key) {
        const input = this.#cell(index, key);
        input?.focus();
        input?.scrollIntoView({ block: 'nearest' });
    }

    #position(target) {
        const row = target.closest('[data-row]');
        return row ? { index: Number(row.dataset.row), key: target.dataset.key } : null;
    }
}
