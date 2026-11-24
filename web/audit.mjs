import { wireAccountNav } from './shared/account.mjs';
import { addDays, DateRangePicker, isIsoDay, rangeBounds, today } from './shared/date-range.mjs';
import { hydrateIcons } from './shared/icons.mjs';
import { button, element, get, number, pageWindow, request } from './shared/ui.mjs';
import { displayNameOf, fillAvatar } from './shared/user.mjs';

const RETENTION_DAYS = 90;
const COLUMNS = 8;

const rows = get('audit-rows');
const pagination = get('audit-pagination');
const previous = get('audit-previous');
const next = get('audit-next');
const status = get('audit-status');
const empty = get('audit-empty');
const refresh = get('audit-refresh');
const reset = get('audit-reset');
const auditCount = get('audit-count');

let state = stateFromUrl();
let totalPages = 1;
let loading = null;

const dateRange = new DateRangePicker(get('audit-date-range'), {
    min: addDays(today(), 1 - RETENTION_DAYS),
    max: today(),
    presets: [
        { label: 'Today', days: 1 },
        { label: 'Last 7 days', days: 7 },
        { label: 'Last 30 days', days: 30 },
        { label: 'Last 90 days', days: RETENTION_DAYS },
    ],
    onChange: range => navigate({ ...range, page: 1 }),
});
dateRange.value = state;

wireAccountNav({ onError: showError });
previous.addEventListener('click', () => goTo(state.page - 1));
next.addEventListener('click', () => goTo(state.page + 1));
refresh.addEventListener('click', () => load());
reset.addEventListener('click', () => navigate({ from: '', to: '', page: 1 }));
window.addEventListener('popstate', () => {
    state = stateFromUrl();
    dateRange.value = state;
    void load();
});

await load();

function stateFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const page = Number(params.get('page'));
    const from = isIsoDay(params.get('from')) ? params.get('from') : '';
    const to = isIsoDay(params.get('to')) ? params.get('to') : from;
    return { from, to: from && to < from ? from : to, page: Number.isSafeInteger(page) && page > 1 ? page : 1 };
}

function urlFor({ from, to, page }) {
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to && to !== from) params.set('to', to);
    if (page > 1) params.set('page', String(page));
    const query = params.toString();
    return query ? `?${query}` : window.location.pathname;
}

function navigate(changes) {
    const nextState = { ...state, ...changes };
    if (urlFor(nextState) === urlFor(state)) return;
    state = nextState;
    dateRange.value = state;
    history.pushState(null, '', urlFor(state));
    void load();
}

function goTo(page) {
    if (page >= 1 && page <= totalPages) navigate({ page });
}

function apiUrl({ from, to, page }) {
    const bounds = rangeBounds({ from, to });
    const params = new URLSearchParams();
    if (page > 1) params.set('page', String(page));
    if (bounds.from !== undefined) params.set('from', String(bounds.from));
    if (bounds.to !== undefined) params.set('to', String(bounds.to));
    const query = params.toString();
    return `/api/audit${query ? `?${query}` : ''}`;
}

async function load() {
    loading?.abort();
    const controller = new AbortController();
    loading = controller;
    renderSkeletonRows(5);
    rows.setAttribute('aria-busy', 'true');
    refresh.disabled = true;
    const filtered = Boolean(state.from);
    reset.hidden = !filtered;

    try {
        const result = await request(apiUrl(state), { signal: controller.signal });
        if (loading !== controller) return;
        totalPages = result.totalPages;
        rows.replaceChildren(...result.events.map(auditRow));
        status.textContent = '';
        empty.hidden = result.events.length > 0;
        renderEmpty(filtered);
        auditCount.textContent = countLabel(result.total, filtered);
        renderPagination(result);
        if (result.page !== state.page) {
            state = { ...state, page: result.page };
            history.replaceState(null, '', urlFor(state));
        }
    } catch (error) {
        if (error.name !== 'AbortError') showError(error);
    } finally {
        if (loading === controller) {
            rows.removeAttribute('aria-busy');
            refresh.disabled = false;
            loading = null;
        }
        hydrateIcons();
    }
}

function countLabel(total, filtered) {
    if (!total) return filtered ? 'No events in this date range' : 'No events logged';
    const events = `${number.format(total)} ${filtered ? 'matching' : 'recorded'} event${total === 1 ? '' : 's'}`;
    return filtered ? events : `${events} · kept for ${RETENTION_DAYS} days`;
}

function renderEmpty(filtered) {
    get('audit-empty-title').textContent = filtered ? 'No events in this date range' : 'No audit events yet';
    get('audit-empty-copy').textContent = filtered
        ? 'Try a wider range, or reset the filters to see every event.'
        : `System actions, logins, and operations will be logged here. Events older than ${RETENTION_DAYS} days are removed automatically.`;
}

function renderPagination({ page, pageSize, total }) {
    pagination.hidden = totalPages <= 1;
    if (pagination.hidden) return;
    const first = ((page - 1) * pageSize) + 1;
    const last = Math.min(total, page * pageSize);
    get('audit-range').textContent = `Showing ${number.format(first)}–${number.format(last)} of ${number.format(total)}`;
    previous.disabled = page <= 1;
    next.disabled = page >= totalPages;
    get('audit-pages').replaceChildren(...pageWindow(page, totalPages).map(item => pageButton(item, page)));
}

function pageButton(item, current) {
    if (item === 'gap') return element('span', 'page-gap', '…');
    const target = button(number.format(item), () => goTo(item), 'page-button');
    target.setAttribute('aria-label', `Page ${item}`);
    if (item === current) target.setAttribute('aria-current', 'page');
    return target;
}

function renderSkeletonRows(count) {
    const sizes = ['short', 'actor', 'wide', 'pill', 'wide', 'line', 'pill', 'tiny'];
    rows.replaceChildren(...Array.from({ length: count }, () => {
        const tr = element('tr', 'skeleton-row');
        tr.setAttribute('aria-hidden', 'true');
        for (const size of sizes.slice(0, COLUMNS)) {
            const cell = tr.insertCell();
            if (size === 'pill') cell.append(element('span', 'skeleton skeleton-pill'));
            else if (size === 'actor') cell.append(element('span', 'skeleton skeleton-avatar'), element('span', 'skeleton skeleton-line short'));
            else cell.append(element('span', `skeleton skeleton-line ${size}`));
        }
        return tr;
    }));
}

function auditRow(event) {
    const tr = element('tr', 'audit-row');
    const date = new Date(event.occurredAt);
    const time = tr.insertCell();
    time.className = 'audit-time-cell';
    time.textContent = date.toLocaleString();
    time.title = date.toISOString();

    const actor = tr.insertCell();
    actor.className = 'audit-actor-cell';
    actor.append(actorName(event));
    const email = tr.insertCell();
    email.className = 'audit-email-cell';
    email.append(event.actorEmail ? textWithTitle('span', 'audit-actor-email', event.actorEmail) : none());

    tr.insertCell().append(badge('source', event.source || 'web'));
    tr.insertCell().append(element('span', 'audit-action', event.action || '—'));
    tr.insertCell().append(event.target ? textWithTitle('span', 'audit-target', event.target) : none());
    tr.insertCell().append(badge('outcome', event.outcome || 'unknown', event.outcome || '—'));
    tr.insertCell().append(requestId(event.requestId));
    return tr;
}

function actorName(event) {
    if (event.actorId === null || event.actorId === undefined) return element('span', 'audit-actor-none', systemActor(event.source));
    const user = { name: event.actorName, email: event.actorEmail, picture: event.actorPicture };
    const wrapper = element('span', 'audit-actor');
    const avatar = element('span', 'audit-avatar');
    avatar.setAttribute('aria-hidden', 'true');
    fillAvatar(avatar, user);
    const name = event.actorEmail ? displayNameOf(user) : `Removed user #${event.actorId}`;
    const text = element('span', 'audit-actor-text');
    text.append(textWithTitle('span', 'audit-actor-name', name));
    if (event.actorEmail) text.append(textWithTitle('span', 'audit-actor-sub', event.actorEmail));
    wrapper.append(avatar, text);
    return wrapper;
}

function systemActor(source) {
    return { cli: 'Command line', worker: 'Background worker' }[source] ?? 'Anonymous';
}

function badge(kind, value, text = value) {
    return element('span', `audit-badge audit-${kind}-${value}`, text);
}

function requestId(id) {
    if (!id) return none();
    const code = element('code', 'audit-request-id', id.length > 10 ? `${id.slice(0, 10)}…` : id);
    code.title = id;
    return code;
}

function textWithTitle(tag, className, text) {
    const node = element(tag, className, text);
    node.title = text;
    return node;
}

function none() {
    return element('span', 'audit-actor-none', '—');
}

function showError(error) {
    status.textContent = error instanceof Error ? error.message : String(error);
}
