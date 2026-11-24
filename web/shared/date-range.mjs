// A popover date-range picker: presets on the left, two months of calendar on the right.
// Days are plain local dates written as "YYYY-MM-DD" so they survive URLs and comparisons unchanged.
import { icon } from './icons.mjs';
import { button, element } from './ui.mjs';

const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const monthTitle = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' });
const dayLabel = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
const shortDate = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const fullDate = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const SINGLE_MONTH = window.matchMedia('(max-width: 720px)');
const KEY_STEPS = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };

export class DateRangePicker {
    #root;
    #trigger;
    #label;
    #popover;
    #months;
    #summary;
    #apply;
    #presets;
    #min;
    #max;
    #onChange;
    #value = { from: '', to: '' };
    #draft = { from: '', to: '' };
    #hover = '';
    #focus = '';
    #month;

    /**
     * @param {HTMLElement} root  Empty container the picker renders into.
     * @param {{ min?: string, max?: string, presets?: { label: string, days: number }[], onChange: (range: { from: string, to: string }) => void }} options
     */
    constructor(root, { min = '', max = '', presets = [], onChange }) {
        this.#root = root;
        this.#min = min;
        this.#max = max;
        this.#onChange = onChange;
        this.#month = startOfMonth(max || today());
        this.#build(presets);
    }

    get value() {
        return { ...this.#value };
    }

    /** Sets the shown range without notifying `onChange`. */
    set value({ from = '', to = '' }) {
        this.#value = { from, to };
        this.#renderLabel();
    }

    open() {
        this.#draft = { ...this.#value };
        this.#hover = '';
        // Two months show side by side on wider screens, so lead with the month before the range's end there.
        const end = this.#value.to || this.#max || today();
        this.#month = startOfMonth(SINGLE_MONTH.matches ? end : addMonths(end, -1));
        if (this.#min && this.#month < startOfMonth(this.#min)) this.#month = startOfMonth(this.#min);
        this.#focus = this.#value.from || this.#value.to || this.#max || today();
        this.#popover.hidden = false;
        this.#trigger.setAttribute('aria-expanded', 'true');
        this.#render();
        this.#focusDay();
    }

    close({ restoreFocus = true } = {}) {
        if (this.#popover.hidden) return;
        this.#popover.hidden = true;
        this.#trigger.setAttribute('aria-expanded', 'false');
        if (restoreFocus) this.#trigger.focus();
    }

    #build(presets) {
        this.#root.classList.add('date-range');
        this.#trigger = button('', () => (this.#popover.hidden ? this.open() : this.close()), 'button secondary small date-range-trigger', 'calendar');
        this.#trigger.setAttribute('aria-haspopup', 'dialog');
        this.#trigger.setAttribute('aria-expanded', 'false');
        this.#label = this.#trigger.querySelector('.label');
        this.#trigger.append(icon('chevron-down', 13));

        this.#popover = element('div', 'date-range-popover');
        this.#popover.hidden = true;
        this.#popover.setAttribute('role', 'dialog');
        this.#popover.setAttribute('aria-label', 'Choose a date range');

        this.#presets = element('div', 'date-range-presets');
        this.#presets.append(...presets.map(preset => {
            const choice = button(preset.label, () => this.#choosePreset(preset.days), 'date-range-preset');
            choice.dataset.days = String(preset.days);
            return choice;
        }));
        this.#months = element('div', 'date-range-months');
        this.#months.addEventListener('keydown', event => this.#onKey(event));
        this.#months.addEventListener('pointerleave', () => this.#preview(''));

        this.#summary = element('span', 'date-range-summary');
        this.#apply = button('Apply', () => this.#commit(this.#draft), 'button primary small');
        const footer = element('footer', 'date-range-footer');
        const actions = element('div', 'date-range-actions');
        actions.append(button('Cancel', () => this.close(), 'button secondary small'), this.#apply);
        footer.append(this.#summary, actions);

        const body = element('div', 'date-range-body');
        body.append(this.#presets, this.#months);
        this.#popover.append(body, footer);
        this.#popover.addEventListener('keydown', event => {
            if (event.key === 'Escape') this.close();
        });
        document.addEventListener('pointerdown', event => {
            if (!this.#root.contains(event.target)) this.close({ restoreFocus: false });
        });
        this.#root.replaceChildren(this.#trigger, this.#popover);
        this.#renderLabel();
    }

    #choosePreset(days) {
        const to = this.#max || today();
        let from = addDays(to, 1 - days);
        if (this.#min && from < this.#min) from = this.#min;
        this.#commit({ from, to });
    }

    #commit(range) {
        const from = range.from;
        const to = range.to || range.from;
        this.#value = { from, to };
        this.#renderLabel();
        this.close();
        this.#onChange({ from, to });
    }

    #pick(day) {
        const { from, to } = this.#draft;
        if (!from || to) this.#draft = { from: day, to: '' };
        else this.#draft = day < from ? { from: day, to: from } : { from, to: day };
        this.#focus = day;
        this.#hover = '';
        this.#render();
        this.#focusDay();
    }

    #preview(day) {
        if (this.#hover === day || !this.#draft.from || this.#draft.to) return;
        this.#hover = day;
        this.#paintRange();
    }

    #onKey(event) {
        const step = KEY_STEPS[event.key];
        if (step === undefined) return;
        event.preventDefault();
        const next = clamp(addDays(this.#focus, step), this.#min, this.#max);
        this.#focus = next;
        this.#preview(next);
        const shown = SINGLE_MONTH.matches ? 1 : 2;
        if (next < this.#month) this.#month = startOfMonth(next);
        else if (next >= addMonths(this.#month, shown)) this.#month = addMonths(startOfMonth(next), 1 - shown);
        this.#render();
        this.#focusDay();
    }

    #shiftMonth(delta) {
        this.#month = addMonths(this.#month, delta);
        this.#render();
    }

    #render() {
        const second = addMonths(this.#month, 1);
        this.#months.replaceChildren(this.#monthGrid(this.#month, 'previous'), this.#monthGrid(second, 'next'));
        this.#paintRange();
        const { from, to } = this.#draft;
        this.#summary.textContent = from ? describe(from, to || '') : 'Pick a start date';
        this.#apply.disabled = !from;
        for (const preset of this.#presets.children) {
            const days = Number(preset.dataset.days);
            const to = this.#max || today();
            preset.setAttribute('aria-pressed', String(this.#value.to === to && this.#value.from === clamp(addDays(to, 1 - days), this.#min, to)));
        }
    }

    #monthGrid(month, side) {
        // Both months carry both arrows; CSS hides the inner pair while two months sit side by side.
        const section = element('section', 'date-range-month');
        const head = element('header', 'date-range-month-head');
        const title = element('h3', '', monthTitle.format(toDate(month)));
        title.id = `date-range-${side}-${month}`;
        const back = navButton('Previous month', 'chevron-left', () => this.#shiftMonth(-1));
        back.disabled = Boolean(this.#min) && month <= startOfMonth(this.#min);
        const forward = navButton('Next month', 'chevron-right', () => this.#shiftMonth(1));
        forward.disabled = Boolean(this.#max) && addMonths(month, 1) > startOfMonth(this.#max);
        head.append(back, title, forward);

        const grid = element('div', 'date-range-grid');
        grid.setAttribute('role', 'group');
        grid.setAttribute('aria-labelledby', title.id);
        grid.append(...WEEKDAYS.map(day => element('span', 'date-range-weekday', day)));
        const offset = (toDate(month).getDay() + 6) % 7;
        for (let blank = 0; blank < offset; blank++) grid.append(element('span'));
        for (let day = month; day < addMonths(month, 1); day = addDays(day, 1)) grid.append(this.#dayButton(day));
        section.append(head, grid);
        return section;
    }

    #dayButton(day) {
        const cell = element('button', 'date-range-day', String(Number(day.slice(8))));
        cell.type = 'button';
        cell.dataset.day = day;
        cell.setAttribute('aria-label', dayLabel.format(toDate(day)));
        cell.tabIndex = day === this.#focus ? 0 : -1;
        cell.disabled = Boolean((this.#min && day < this.#min) || (this.#max && day > this.#max));
        if (day === today()) cell.classList.add('today');
        cell.addEventListener('click', () => this.#pick(day));
        cell.addEventListener('pointerenter', () => this.#preview(day));
        return cell;
    }

    /** Re-marks the start, end and in-between days without rebuilding the grid. */
    #paintRange() {
        const { from } = this.#draft;
        const end = this.#draft.to || this.#hover;
        const [start, finish] = end && end < from ? [end, from] : [from, end || from];
        for (const cell of this.#months.querySelectorAll('.date-range-day')) {
            const day = cell.dataset.day;
            const inside = Boolean(start) && day >= start && day <= finish;
            cell.classList.toggle('in-range', inside && day !== start && day !== finish);
            cell.classList.toggle('range-start', Boolean(start) && day === start);
            cell.classList.toggle('range-end', Boolean(start) && day === finish);
            cell.setAttribute('aria-pressed', String(inside));
        }
    }

    #focusDay() {
        this.#months.querySelector(`[data-day="${this.#focus}"]`)?.focus({ preventScroll: true });
    }

    #renderLabel() {
        const { from, to } = this.#value;
        this.#label.textContent = from ? describe(from, to) : 'All dates';
        this.#trigger.classList.toggle('active', Boolean(from));
    }
}

function navButton(label, iconName, onClick) {
    const nav = button('', onClick, 'icon-button date-range-nav', iconName);
    nav.setAttribute('aria-label', label);
    return nav;
}

/** Milliseconds for the first and last instant of a local-date range, for querying timestamps. */
export function rangeBounds({ from, to }) {
    return {
        from: from ? toDate(from).getTime() : undefined,
        to: to ? toDate(addDays(to, 1)).getTime() - 1 : undefined,
    };
}

export function isIsoDay(value) {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value) && toIso(toDate(value)) === value;
}

export function today() {
    return toIso(new Date());
}

export function addDays(day, count) {
    const date = toDate(day);
    date.setDate(date.getDate() + count);
    return toIso(date);
}

function addMonths(day, count) {
    const date = toDate(day);
    return toIso(new Date(date.getFullYear(), date.getMonth() + count, 1));
}

function startOfMonth(day) {
    return `${day.slice(0, 7)}-01`;
}

function clamp(day, min, max) {
    if (min && day < min) return min;
    if (max && day > max) return max;
    return day;
}

function describe(from, to) {
    if (!to || from === to) return fullDate.format(toDate(from));
    const sameYear = from.slice(0, 4) === to.slice(0, 4);
    return `${(sameYear ? shortDate : fullDate).format(toDate(from))} – ${fullDate.format(toDate(to))}`;
}

function toDate(day) {
    const [year, month, date] = day.split('-').map(Number);
    return new Date(year, month - 1, date);
}

function toIso(date) {
    const pad = value => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
