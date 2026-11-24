import { get, request } from './shared/ui.mjs';

const rows = get('audit-rows');
const more = get('audit-more');
const status = get('audit-status');
let cursor = '';

more.addEventListener('click', load);
await load();

async function load() {
    more.disabled = true;
    try {
        const { events, next } = await request(`/api/audit${cursor ? `?before=${cursor}` : ''}`);
        for (const event of events) {
            const row = rows.insertRow();
            for (const value of [new Date(event.occurredAt).toLocaleString(), event.actorId, event.source, event.action, event.target, event.outcome, event.requestId]) {
                row.insertCell().textContent = value ?? '—';
            }
        }
        cursor = next;
        status.textContent = rows.rows.length ? '' : 'No audit events yet.';
        more.hidden = !cursor;
    } catch (error) {
        status.textContent = error.message;
    } finally {
        more.disabled = false;
    }
}
