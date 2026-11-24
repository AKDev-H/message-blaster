import { channelMark } from './brands.mjs';
import { renderRichText } from './editor.mjs';
import { button, campaignPath, element, get, link, number, request, setError } from './ui.mjs';

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
const channelLabels = { gmail: 'Gmail', whatsapp: 'WhatsApp' };
const recipientStatuses = {
    PENDING: 'Queued', VALIDATING: 'Queued', QUEUED: 'Queued', SENDING: 'Processing', SENT: 'Sent',
    DELIVERED: 'Delivered', READ: 'Read', FAILED: 'Failed', SKIPPED: 'Skipped', UNKNOWN: 'Needs review',
};
export const countKeys = ['queued', 'processing', 'completed', 'failed', 'unknown', 'skipped'];
const countLabels = {
    queued: 'Queued', processing: 'Processing', completed: 'Completed',
    failed: 'Failed', unknown: 'Needs review', skipped: 'Skipped',
};

const statusOf = campaign => campaign.runStatus || campaign.state;
const isActive = campaign => campaign.runActive || campaign.state === 'Running' || campaign.processing > 0;
const settled = campaign => campaign.completed + campaign.failed + campaign.unknown + campaign.skipped;

function badge(status) {
    return element('span', `badge ${status.toLowerCase().replaceAll(' ', '-')}`, status);
}

function formatDate(value) {
    const time = new Date(value);
    return Number.isNaN(time.valueOf()) ? '—' : dateFormat.format(time);
}

function progress(campaign) {
    const meter = element('progress');
    meter.max = Math.max(1, campaign.total);
    meter.value = settled(campaign);
    meter.setAttribute('aria-label', `Progress for ${campaign.id}`);
    return meter;
}

export function createQueue(onOpen) {
    const rows = get('campaign-rows');
    const channelFilter = get('channel-filter');
    const stateFilter = get('state-filter');
    let signature = '';
    let latest = { campaigns: null, selected: '' };

    function campaignRow(campaign, selected) {
        const row = element('tr');
        row.classList.toggle('selected', selected);

        const identity = element('div', 'campaign-identity');
        const name = element('div');
        const open = button(campaign.id, () => onOpen(campaign.id), 'campaign-link');
        open.dataset.campaign = campaign.id;
        open.setAttribute('aria-controls', 'details');
        open.setAttribute('aria-expanded', String(selected));
        name.append(open, element('span', 'muted block', campaign.isTest ? `${channelLabels[campaign.channel]} test` : channelLabels[campaign.channel]));
        identity.append(channelMark(campaign.channel), name);

        const status = element('td');
        status.append(badge(statusOf(campaign)));

        const progressCell = element('td', 'progress-cell');
        progressCell.append(progress(campaign),
            element('span', 'muted block', `${number.format(settled(campaign))} / ${number.format(campaign.total)}`));

        const view = button('View', () => onOpen(campaign.id), 'button ghost small', 'chevron-right');
        view.setAttribute('aria-label', `View ${campaign.id}`);
        const viewCell = element('td', 'open-cell');
        viewCell.append(view);

        const identityCell = element('td');
        identityCell.append(identity);
        row.append(identityCell, status, progressCell, element('td', 'muted date-cell', formatDate(campaign.updatedAt)), viewCell);
        return row;
    }

    function render(campaigns = latest.campaigns, selected = latest.selected) {
        latest = { campaigns, selected };
        if (!campaigns) return;
        const channel = channelFilter.value;
        const status = stateFilter.value;
        const visible = campaigns.filter(campaign =>
            (!channel || channel === campaign.channel) && (!status || status === campaign.state));
        const filtered = campaigns.length > 0;

        get('campaign-count').textContent = `${number.format(visible.length)} of ${number.format(campaigns.length)}`;
        get('campaign-table').hidden = visible.length === 0;
        get('campaign-empty').hidden = visible.length !== 0;
        get('empty-heading').textContent = filtered ? 'No matching campaigns' : 'No campaigns yet';
        get('empty-copy').textContent = filtered ? 'Try clearing the filters.' : 'Import an Excel workbook to get started.';
        get('empty-action').textContent = filtered ? 'Clear filters' : 'New campaign';

        const next = JSON.stringify([selected, visible]);
        if (next === signature) return;
        signature = next;
        const focused = document.activeElement?.dataset.campaign;
        rows.replaceChildren(...visible.map(campaign => campaignRow(campaign, campaign.id === selected)));
        if (focused) rows.querySelector(`[data-campaign="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
    }

    function clearFilters() {
        channelFilter.value = '';
        stateFilter.value = '';
        render();
    }

    channelFilter.addEventListener('change', () => render());
    stateFilter.addEventListener('change', () => render());
    return { render, clearFilters };
}

export function createDetails({ onEdit, onAction, onClose, onViewAttachment }) {
    const panel = get('details');
    const actionsTarget = get('detail-actions');
    const recipientRows = get('detail-rows');
    let selected = '';
    let page = 1;
    let detail = null;
    let pendingRequest = null;
    let overview = { campaigns: [], dryRun: true };

    function reset(id) {
        selected = id;
        page = 1;
        detail = null;
        get('detail-heading').textContent = id;
        get('detail-description').textContent = 'Loading…';
        for (const key of ['detail-state', 'detail-actions', 'detail-rows', 'detail-summary', 'page-number']) get(key).replaceChildren();
        delete actionsTarget.dataset.signature;
        paginate(1, 1);
    }

    function availableActions(campaign, latest) {
        const active = isActive(latest);
        const anotherActive = overview.campaigns.some(row => row.id !== campaign.id && isActive(row));
        const list = [];
        if (detail.draft && !active) list.push(button('Edit', () => onEdit(detail), undefined, 'pencil'));
        if (!active && ['Ready', 'Paused', 'Failed'].includes(latest.state) && latest.queued > 0 &&
            (!campaign.isTest || latest.state !== 'Ready')) {
            const action = latest.state === 'Ready' ? 'start' : 'resume';
            const node = button(action === 'start' ? 'Start sending' : 'Resume', () => onAction(action, latest), 'button primary small',
                action === 'start' ? 'send' : 'play');
            node.disabled = overview.dryRun || anotherActive;
            if (overview.dryRun) node.title = 'Sending is turned off in preview mode';
            else if (anotherActive) node.title = 'Another campaign is sending';
            list.push(node);
        }
        if (latest.runStatus === 'Connecting' || (latest.state === 'Running' && !latest.runStatus)) {
            list.push(button('Pause', () => onAction('pause', latest), undefined, 'pause'));
        }
        if (!active && latest.failed > 0 && !['Draft', 'Ready', 'Cancelled'].includes(latest.state)) {
            list.push(button('Retry failed', () => onAction('retry', latest), undefined, 'rotate-ccw'));
        }
        list.push(link('Export', `${campaignPath(campaign.id)}/export`, undefined, 'download'));
        if (!['Completed', 'Cancelled'].includes(latest.state) && latest.runStatus !== 'Cancelling') {
            list.push(button('Cancel', () => onAction('cancel', latest), 'button quiet-danger small', 'ban'));
        }
        if (!active) list.push(button('Delete', () => onAction('delete', latest), 'button quiet-danger small', 'trash-2'));
        return { list, signature: JSON.stringify([campaign.id, Boolean(detail.draft), latest.state, latest.runStatus, active,
            latest.queued > 0, latest.failed > 0, anotherActive, overview.dryRun]) };
    }

    function renderHeader() {
        const { campaign } = detail;
        const latest = overview.campaigns.find(row => row.id === campaign.id) ?? campaign;
        get('detail-heading').textContent = campaign.id;
        get('detail-state').replaceChildren(badge(statusOf(latest)));
        const recipients = `${number.format(latest.total)} ${latest.total === 1 ? 'recipient' : 'recipients'}`;
        get('detail-description').replaceChildren(channelMark(campaign.channel),
            element('span', '', `${channelLabels[campaign.channel]}${campaign.isTest ? ' test' : ''}, ${recipients}`));
        setError('detail-error', latest.runError || '');

        const { list, signature } = availableActions(campaign, latest);
        if (actionsTarget.dataset.signature === signature) return;
        const focused = actionsTarget.contains(document.activeElement) ? document.activeElement.textContent : '';
        actionsTarget.dataset.signature = signature;
        actionsTarget.replaceChildren(...list);
        if (focused) list.find(node => node.textContent === focused)?.focus({ preventScroll: true });
    }

    function messageCell(record) {
        const cell = element('td', 'message-preview');
        if (record.subject) cell.append(element('strong', 'block', record.subject));
        if (record.message) {
            const body = element('details', 'message-body');
            body.dataset.record = String(record.id);
            const full = element('div', 'message-rich');
            if (record.messageHtml) renderRichText(full, record.messageHtml);
            else {
                full.classList.add('plain');
                full.textContent = record.message;
            }
            body.append(element('summary', '', record.message.replaceAll(/\s+/gu, ' ').trim()), full);
            cell.append(body);
        }
        if (record.pdfFilename) {
            const file = button(record.pdfFilename, () => onViewAttachment(record.pdfFilename), 'file-pill', 'paperclip');
            file.title = `View ${record.pdfFilename}`;
            cell.append(file);
        }
        if (!cell.childNodes.length) cell.textContent = '—';
        return cell;
    }

    function recipientRow(record, campaign, opened) {
        const row = element('tr');
        const identity = element('td');
        identity.append(
            element('strong', 'block', record.clientName || `Row ${record.rowNumber}`),
            element('span', 'muted block', record.email || record.phone || 'No valid address'),
        );
        const message = messageCell(record);
        const toggle = message.querySelector('details');
        if (toggle) toggle.open = opened.has(toggle.dataset.record);

        const status = element('td', 'recipient-status');
        status.append(badge(recipientStatuses[record.status] ?? record.status));
        if (record.errorMessage) status.append(element('span', 'muted block', record.errorMessage));
        if (record.status === 'UNKNOWN') status.append(button('Review', () => onAction('review', campaign, record.id), undefined, 'clipboard-check'));
        row.append(identity, message, status, element('td', 'muted', number.format(record.attemptCount)));
        return row;
    }

    function render() {
        const { campaign, rows, totalPages } = detail;
        renderHeader();
        get('detail-summary').replaceChildren(...countKeys.filter(key => campaign[key] || key === 'queued').map(key => {
            const node = element('div', `detail-count ${key}`);
            node.append(element('strong', '', number.format(campaign[key] ?? 0)), element('span', '', countLabels[key]));
            return node;
        }));
        const opened = new Set([...recipientRows.querySelectorAll('.message-body[open]')].map(node => node.dataset.record));
        const content = rows.map(record => recipientRow(record, campaign, opened));
        if (!content.length) {
            const cell = element('td', 'muted', 'No recipients.');
            cell.colSpan = 4;
            const row = element('tr');
            row.append(cell);
            content.push(row);
        }
        recipientRows.replaceChildren(...content);
        paginate(detail.page, totalPages);
    }

    function paginate(current, total) {
        get('page-number').textContent = `${number.format(current)} / ${number.format(Math.max(1, total))}`;
        get('previous-page').disabled = current <= 1;
        get('next-page').disabled = current >= total;
    }

    async function load() {
        if (!selected) return;
        pendingRequest?.abort();
        const active = new AbortController();
        pendingRequest = active;
        try {
            const result = await request(`${campaignPath(selected)}?page=${page}`, { signal: active.signal });
            if (pendingRequest !== active) return;
            detail = result;
            page = result.page;
            render();
        } catch (error) {
            if (error.name === 'AbortError' || pendingRequest !== active) return;
            page = detail?.page ?? 1;
            paginate(page, detail?.totalPages ?? 1);
            setError('detail-error', error);
        }
    }

    function open(id) {
        if (selected !== id) reset(id);
        setError('detail-error', '');
        panel.hidden = false;
        get('detail-heading').focus({ preventScroll: true });
        panel.scrollIntoView({ block: 'start', behavior: 'smooth' });
        return load();
    }

    function close() {
        pendingRequest?.abort();
        pendingRequest = null;
        detail = null;
        selected = '';
        panel.hidden = true;
    }

    function update(next, changed) {
        overview = next;
        if (!selected) return;
        const current = next.campaigns.find(campaign => campaign.id === selected);
        if (!current) {
            close();
            onClose();
        } else if (changed(current)) {
            load();
        } else if (detail) {
            renderHeader();
        }
    }

    function turnPage(direction) {
        if (!detail) return;
        page = detail.page + direction;
        paginate(page, 0);
        load();
    }

    get('close-detail').addEventListener('click', () => {
        const id = selected;
        close();
        onClose(id);
    });
    get('previous-page').addEventListener('click', () => turnPage(-1));
    get('next-page').addEventListener('click', () => turnPage(1));
    return { open, close, update, reload: load, get selected() { return selected; } };
}
