import { channelMark, channelMarks } from '../shared/brands.mjs';
import { CHANNEL_LABELS, channelList, plural } from '../shared/labels.mjs';
import { button, element, get, groupPath, number, request, setError } from '../shared/ui.mjs';
import { buttonSignature, channelButtons, groupButtons } from './actions.mjs';
import { emptyRecipientRow, recipientRow } from './recipient-rows.mjs';
import { badge, statusOf } from './status.mjs';

const OVERVIEW = 'overview';
const METRICS = [
    ['peopleSent', 'People sent to', true],
    ['completed', 'Successful sends', true],
    ['failed', 'Failed', true],
    ['unknown', 'Needs review', false],
    ['queued', 'Queued', true],
    ['processing', 'Sending', false],
    ['delivered', 'Delivered', false],
    ['read', 'Read', false],
    ['skipped', 'Skipped', false],
];

export class CampaignDetails {
    #panel = get('details');
    #actions = get('detail-actions');
    #channelActions = get('channel-actions');
    #recipientRows = get('detail-rows');
    #tabs = get('detail-tabs');
    #slug = '';
    #view = OVERVIEW;
    #pages = new Map();
    #detail = null;
    #rows = null;
    #pendingRequest = null;

    constructor(on) {
        this.on = on;
        get('close-detail').addEventListener('click', () => this.on.close());
        get('previous-page').addEventListener('click', () => this.#turnPage(-1));
        get('next-page').addEventListener('click', () => this.#turnPage(1));
        this.#tabs.addEventListener('keydown', event => this.#moveTab(event));
    }

    get selected() {
        return this.#slug;
    }

    get current() {
        if (!this.#detail) return null;
        const { campaign, channels } = this.#detail;
        return { slug: campaign.slug, name: campaign.name, version: campaign.version, channels: channels.map(channel => channel.channel) };
    }

    get detail() {
        return this.#detail;
    }

    open(slug) {
        if (this.#slug !== slug) this.#reset(slug);
        setError('detail-error', '');
        this.#panel.hidden = false;
        get('detail-heading').focus({ preventScroll: true });
        return this.reload();
    }

    close() {
        this.#pendingRequest?.abort();
        this.#pendingRequest = null;
        this.#detail = null;
        this.#rows = null;
        this.#slug = '';
        this.#panel.hidden = true;
    }

    showChannel(channel) {
        if (!this.#detail || this.#view === channel) return;
        this.#view = channel;
        this.#rows = null;
        this.#recipientRows.replaceChildren(...skeletonRecipientRows());
        this.#render();
        this.reload();
    }

    async reload() {
        if (!this.#slug) return;
        this.#pendingRequest?.abort();
        const loading = new AbortController();
        this.#pendingRequest = loading;
        try {
            const detail = await request(groupPath(this.#slug), { signal: loading.signal });
            const view = this.#viewFor(detail);
            const rows = view === OVERVIEW ? null : await request(this.#rowsUrl(view), { signal: loading.signal });
            this.#show(detail, rows, loading);
        } catch (error) {
            if (error.name === 'AbortError' || this.#pendingRequest !== loading) return;
            if (error.status === 404) {
                this.close();
                this.on.missing();
            } else {
                setError('detail-error', error);
            }
        }
    }

    #viewFor(detail) {
        if (detail.channels.length === 1) return detail.channels[0].channel;
        return detail.campaign.channels.includes(this.#view) ? this.#view : OVERVIEW;
    }

    #rowsUrl(channel) {
        return `${groupPath(this.#slug)}/${channel}?page=${this.#pages.get(channel) ?? 1}`;
    }

    #show(detail, rows, loading) {
        if (this.#pendingRequest !== loading) return;
        this.#detail = detail;
        this.#view = this.#viewFor(detail);
        this.#rows = rows;
        if (rows) this.#pages.set(this.#view, rows.page);
        document.title = `${detail.campaign.name} | Message Blaster`;
        this.#render();
    }

    #reset(slug) {
        this.#slug = slug;
        this.#view = OVERVIEW;
        this.#pages.clear();
        this.#detail = null;
        this.#rows = null;
        get('detail-heading').textContent = slug;
        get('detail-description').replaceChildren(element('span', 'skeleton skeleton-line wide'));
        for (const key of ['detail-state', 'detail-actions', 'detail-summary', 'detail-channels', 'channel-actions', 'page-number']) get(key).replaceChildren();
        this.#tabs.hidden = true;
        get('detail-notice').hidden = true;
        get('channel-toolbar').hidden = true;
        get('detail-channels').hidden = true;
        get('detail-recipients').hidden = false;
        this.#recipientRows.replaceChildren(...skeletonRecipientRows());
        delete this.#actions.dataset.signature;
        paginate(1, 1);
    }

    #render() {
        const { campaign, channels } = this.#detail;
        const combined = channels.length > 1;
        const channel = channels.find(item => item.channel === this.#view);
        this.#renderHeader();
        this.#renderTabs(combined);
        this.#renderNotice();
        this.#renderMetrics(channel && combined ? { ...channel.metrics, peopleSent: channel.metrics.completed } : this.#detail.metrics, channels);
        get('detail-channels').hidden = Boolean(channel);
        if (!channel) this.#renderChannelCards(channels);
        get('detail-recipients').hidden = !channel;
        get('channel-toolbar').hidden = !channel || !combined;
        if (channel && combined) this.#renderChannelToolbar(channel);
        if (channel && this.#rows) this.#renderRecipients(channel);
        setError('detail-error', (channel ? channel.runError : campaign.runError) || '');
    }

    #renderHeader() {
        const { campaign, channels, metrics } = this.#detail;
        get('detail-heading').textContent = campaign.name;
        get('detail-state').replaceChildren(badge(statusOf(campaign)));
        get('detail-description').replaceChildren(channelMarks(campaign.channels), element('span', '', describe(campaign, channels, metrics)));
        const signature = buttonSignature(this.#detail);
        if (this.#actions.dataset.signature === signature) return;
        const focused = this.#actions.contains(document.activeElement) ? document.activeElement.textContent : '';
        const buttons = groupButtons(this.#detail, this.#handlers());
        this.#actions.dataset.signature = signature;
        this.#actions.replaceChildren(...buttons);
        if (focused) buttons.find(node => node.textContent === focused)?.focus({ preventScroll: true });
    }

    #renderTabs(combined) {
        this.#tabs.hidden = !combined;
        if (!combined) return;
        const views = [OVERVIEW, ...this.#detail.campaign.channels];
        if (this.#tabs.dataset.views !== views.join()) {
            this.#tabs.dataset.views = views.join();
            this.#tabs.replaceChildren(...views.map(view => this.#tab(view)));
        }
        for (const tab of this.#tabs.children) {
            const selected = tab.dataset.detailChannel === this.#view;
            tab.setAttribute('aria-selected', String(selected));
            tab.tabIndex = selected ? 0 : -1;
        }
    }

    #tab(view) {
        const tab = element('button');
        tab.type = 'button';
        tab.setAttribute('role', 'tab');
        tab.dataset.detailChannel = view;
        if (view === OVERVIEW) tab.append(element('span', '', 'Overview'));
        else tab.append(channelMark(view, 14), element('span', '', CHANNEL_LABELS[view]));
        tab.addEventListener('click', () => (view === OVERVIEW ? this.#showOverview() : this.showChannel(view)));
        return tab;
    }

    #showOverview() {
        if (this.#view === OVERVIEW) return;
        this.#view = OVERVIEW;
        this.#rows = null;
        this.#render();
    }

    #moveTab(event) {
        if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
        const tabs = [...this.#tabs.children];
        const index = tabs.findIndex(tab => tab.dataset.detailChannel === this.#view);
        const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
        next.click();
        next.focus();
    }

    #renderNotice() {
        const notice = get('detail-notice');
        const { pending, continuing } = this.#detail.campaign.sendPlan;
        notice.hidden = !pending.length;
        if (!pending.length) return;
        const names = pending.map(channel => CHANNEL_LABELS[channel]).join(' and ');
        notice.textContent = continuing
            ? `${names} will start automatically when the current channel finishes.`
            : `${names} hasn’t started yet. Review it, then send it when you’re ready.`;
    }

    #renderMetrics(metrics, channels) {
        const shown = METRICS.filter(([key, , always]) => always || metrics[key]);
        get('detail-summary').replaceChildren(...shown.map(([key, label]) => metricTile(key, label, metrics[key], channels)));
    }

    #renderChannelCards(channels) {
        get('detail-channels').replaceChildren(...channels.map(channel => this.#channelCard(channel)));
    }

    #channelCard(channel) {
        const card = element('article', 'channel-card');
        card.dataset.channelCard = channel.channel;
        const head = element('header', 'channel-card-head');
        head.append(channelMark(channel.channel), element('strong', '', CHANNEL_LABELS[channel.channel]), badge(statusOf(channel)));
        const { metrics } = channel;
        const facts = element('p', 'muted', [
            `${number.format(metrics.completed)} of ${plural(metrics.total - metrics.skipped, 'recipient', 'recipients')} sent`,
            metrics.failed ? `${number.format(metrics.failed)} failed` : '',
            metrics.unknown ? `${number.format(metrics.unknown)} to review` : '',
        ].filter(Boolean).join(' · '));
        const open = button('View recipients', () => this.showChannel(channel.channel), 'button secondary small', 'chevron-right');
        card.append(head, facts, open);
        return card;
    }

    #renderChannelToolbar(channel) {
        get('channel-toolbar-title').replaceChildren(channelMark(channel.channel), element('strong', '', CHANNEL_LABELS[channel.channel]), badge(statusOf(channel)));
        const signature = JSON.stringify([channel.channel, channel.actions]);
        if (this.#channelActions.dataset.signature === signature) return;
        this.#channelActions.dataset.signature = signature;
        this.#channelActions.replaceChildren(...channelButtons(channel, this.#handlers(), { combined: true }));
    }

    #renderRecipients(channel) {
        const { rows, page, totalPages } = this.#rows;
        const opened = new Set([...this.#recipientRows.querySelectorAll('.message-body[open]')].map(node => node.dataset.record));
        const on = { review: recordId => this.on.action('review', channel.channel, recordId), viewAttachment: this.on.viewAttachment };
        const content = rows.map(record => recipientRow(record, opened, on));
        this.#recipientRows.replaceChildren(...(content.length ? content : [emptyRecipientRow()]));
        paginate(page, totalPages);
    }

    #handlers() {
        return {
            edit: () => this.on.edit(this.#detail),
            action: (action, channel) => this.on.action(action, channel),
            exportUrl: channel => `${groupPath(this.#slug)}/${channel}/export`,
        };
    }

    #turnPage(direction) {
        if (!this.#rows) return;
        const page = this.#rows.page + direction;
        if (page < 1 || page > this.#rows.totalPages) return;
        this.#pages.set(this.#view, page);
        paginate(page, 0);
        this.#recipientRows.replaceChildren(...skeletonRecipientRows(this.#recipientRows.rows.length));
        this.reload();
    }
}

function describe(campaign, channels, metrics) {
    const label = channelList(campaign.channels);
    if (channels.length === 1) return `${label}, ${plural(channels[0].total, 'recipient', 'recipients')}`;
    if (metrics.people === null) return `${label}, ${plural(metrics.total, 'recipient', 'recipients')} across channels`;
    return `${label}, ${plural(metrics.people, 'person', 'people')}`;
}

function metricTile(key, label, value, channels) {
    const node = element('div', `detail-count ${key}`);
    node.dataset.detailMetric = key;
    if (value === null) {
        node.append(element('strong', '', '—'), element('span', '', label));
        node.title = channels.map(channel => `${CHANNEL_LABELS[channel.channel]}: ${number.format(channel.metrics.completed)}`).join(' · ');
        node.append(element('span', 'muted', `(${node.title})`));
        return node;
    }
    node.append(element('strong', '', number.format(value ?? 0)), element('span', '', label));
    return node;
}

function skeletonRecipientRows(count = 6) {
    return Array.from({ length: Math.min(8, Math.max(3, count)) }, () => {
        const row = element('tr', 'skeleton-row');
        row.setAttribute('aria-hidden', 'true');
        for (const size of ['wide', 'wide', 'pill', 'tiny']) {
            const cell = element('td');
            cell.append(element('span', size === 'pill' ? 'skeleton skeleton-pill' : `skeleton skeleton-line ${size}`));
            row.append(cell);
        }
        return row;
    });
}

function paginate(current, total) {
    get('page-number').textContent = `${number.format(current)} / ${number.format(Math.max(1, total))}`;
    get('previous-page').disabled = current <= 1;
    get('next-page').disabled = current >= total;
}
