import { channelMarks } from '../shared/brands.mjs';
import { element, get, groupPath, request, setError } from '../shared/ui.mjs';
import { buttonSignature, channelButtons, groupButtons } from './actions.mjs';
import {
    ALL_RECIPIENTS, channelCard, channelHeading, describeCampaign, metricTiles, OVERVIEW, paginate, sendPlanNotice, skeletonRecipientRows, viewTab,
} from './detail-parts.mjs';
import { emptyRecipientRow, recipientRow } from './recipient-rows.mjs';
import { badge, statusOf } from './status.mjs';

export class CampaignDetails {
    #panel = get('details');
    #actions = get('detail-actions');
    #channelActions = get('channel-actions');
    #recipientRows = get('detail-rows');
    #tabs = get('detail-tabs');
    #slug = '';
    #view = OVERVIEW;
    #filter = ALL_RECIPIENTS;
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
        get('detail-summary').addEventListener('keydown', event => moveFocus(event, get('detail-summary')));
    }

    get selected() {
        return this.#slug;
    }

    get current() {
        if (!this.#detail) return null;
        const { campaign, channels } = this.#detail;
        return { slug: campaign.slug, name: campaign.name, version: campaign.version, channels: channels.map(channel => channel.channel) };
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

    async reload() {
        if (!this.#slug) return;
        this.#pendingRequest?.abort();
        const loading = new AbortController();
        this.#pendingRequest = loading;
        try {
            const detail = await request(groupPath(this.#slug), { signal: loading.signal });
            const view = this.#viewFor(detail);
            const rows = view === OVERVIEW ? null : await request(this.#rowsUrl(view), { signal: loading.signal });
            if (this.#pendingRequest === loading) this.#show(detail, view, rows);
        } catch (error) {
            if (error.name === 'AbortError' || this.#pendingRequest !== loading) return;
            if (error.status !== 404) return setError('detail-error', error);
            this.close();
            this.on.missing();
        }
    }

    #select(view) {
        if (!this.#detail || this.#view === view) return;
        this.#view = view;
        this.#filter = ALL_RECIPIENTS;
        this.#rows = null;
        if (view !== OVERVIEW) this.#recipientRows.replaceChildren(...skeletonRecipientRows());
        this.#render();
        if (view !== OVERVIEW) this.reload();
    }

    #filterBy(key) {
        if (this.#filter === key) return;
        this.#filter = key;
        this.#pages.delete(this.#view);
        this.#rows = null;
        this.#recipientRows.replaceChildren(...skeletonRecipientRows());
        paginate(1, 1);
        this.#render();
        this.reload();
    }

    #viewFor(detail) {
        if (detail.channels.length === 1) return detail.channels[0].channel;
        return detail.campaign.channels.includes(this.#view) ? this.#view : OVERVIEW;
    }

    #rowsUrl(channel) {
        const status = this.#filter === ALL_RECIPIENTS ? '' : `&status=${this.#filter}`;
        return `${groupPath(this.#slug)}/${channel}?page=${this.#pages.get(channel) ?? 1}${status}`;
    }

    #show(detail, view, rows) {
        this.#detail = detail;
        this.#view = view;
        this.#rows = rows;
        if (rows) this.#pages.set(view, rows.page);
        document.title = `${detail.campaign.name} | Message Blaster`;
        this.#render();
    }

    #reset(slug) {
        this.#slug = slug;
        this.#view = OVERVIEW;
        this.#filter = ALL_RECIPIENTS;
        this.#pages.clear();
        this.#detail = null;
        this.#rows = null;
        get('detail-heading').textContent = slug;
        get('detail-description').replaceChildren(element('span', 'skeleton skeleton-line wide'));
        for (const id of ['detail-state', 'detail-actions', 'detail-summary', 'detail-channels', 'channel-actions', 'page-number']) get(id).replaceChildren();
        for (const id of ['detail-tabs', 'detail-notice', 'channel-toolbar', 'detail-channels']) get(id).hidden = true;
        get('detail-recipients').hidden = false;
        this.#recipientRows.replaceChildren(...skeletonRecipientRows());
        delete this.#actions.dataset.signature;
        paginate(1, 1);
    }

    #render() {
        const { campaign, channels, metrics } = this.#detail;
        const combined = channels.length > 1;
        const channel = channels.find(item => item.channel === this.#view);
        this.#renderHeader();
        this.#renderTabs(combined);
        const notice = sendPlanNotice(campaign.sendPlan);
        get('detail-notice').textContent = notice;
        get('detail-notice').hidden = !notice;
        const shown = channel && combined ? { ...channel.metrics, peopleSent: channel.metrics.completed } : metrics;
        const filter = channel ? { active: this.#filter, onSelect: key => this.#filterBy(key) } : null;
        const summary = get('detail-summary');
        const focused = summary.contains(document.activeElement) ? document.activeElement.dataset.detailMetric : '';
        summary.setAttribute('role', filter ? 'tablist' : 'group');
        summary.setAttribute('aria-label', filter ? 'Filter recipients' : 'Campaign totals');
        summary.replaceChildren(...metricTiles(shown, channels, filter));
        if (focused) summary.querySelector(`[data-detail-metric="${focused}"]`)?.focus({ preventScroll: true });
        get('detail-channels').hidden = Boolean(channel);
        if (!channel) get('detail-channels').replaceChildren(...channels.map(item => channelCard(item, view => this.#select(view))));
        get('detail-recipients').hidden = !channel;
        get('channel-toolbar').hidden = !channel || !combined;
        if (channel && combined) this.#renderChannelToolbar(channel);
        if (channel && this.#rows) this.#renderRecipients(channel);
        setError('detail-error', (channel ?? campaign).runError || '');
    }

    #renderHeader() {
        const { campaign } = this.#detail;
        get('detail-heading').textContent = campaign.name;
        get('detail-state').replaceChildren(badge(statusOf(campaign)));
        get('detail-description').replaceChildren(channelMarks(campaign.channels), element('span', '', describeCampaign(this.#detail)));
        replaceButtons(this.#actions, buttonSignature(this.#detail), () => groupButtons(this.#detail, this.#handlers()));
    }

    #renderTabs(combined) {
        this.#tabs.hidden = !combined;
        if (!combined) return;
        const views = [OVERVIEW, ...this.#detail.campaign.channels];
        if (this.#tabs.dataset.views !== views.join()) {
            this.#tabs.dataset.views = views.join();
            this.#tabs.replaceChildren(...views.map(view => viewTab(view, selected => this.#select(selected))));
        }
        for (const tab of this.#tabs.children) {
            const selected = tab.dataset.detailChannel === this.#view;
            tab.setAttribute('aria-selected', String(selected));
            tab.tabIndex = selected ? 0 : -1;
        }
    }

    #moveTab(event) {
        if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
        const tabs = [...this.#tabs.children];
        const index = tabs.findIndex(tab => tab.dataset.detailChannel === this.#view);
        const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
        next.click();
        next.focus();
    }

    #renderChannelToolbar(channel) {
        get('channel-toolbar-title').replaceChildren(channelHeading(channel, 'channel-toolbar-heading'));
        const signature = JSON.stringify([channel.channel, channel.actions]);
        replaceButtons(this.#channelActions, signature, () => channelButtons(channel, this.#handlers(), { combined: true }));
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

function moveFocus(event, list) {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    const tabs = [...list.querySelectorAll('[role="tab"]')];
    const index = tabs.indexOf(document.activeElement);
    if (index < 0) return;
    const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
    next.click();
    next.focus();
}

function replaceButtons(container, signature, build) {
    if (container.dataset.signature === signature) return;
    const focused = container.contains(document.activeElement) ? document.activeElement.textContent : '';
    const buttons = build();
    container.dataset.signature = signature;
    container.replaceChildren(...buttons);
    if (focused) buttons.find(node => node.textContent === focused)?.focus({ preventScroll: true });
}
