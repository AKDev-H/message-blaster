import { channelMark } from '../shared/brands.mjs';
import { CHANNEL_LABELS } from '../shared/labels.mjs';
import { button, element, get, number, replayAnimation } from '../shared/ui.mjs';
import { badge, formatDate, progressBar, progressText, statusOf } from './status.mjs';

const TOTAL_METRICS = ['queued', 'processing', 'completed', 'failed'];

export class CampaignQueue {
    #rows = get('campaign-rows');
    #statusTabs = [...get('status-tabs').querySelectorAll('[data-status]')];
    #channelToggles = [...get('channel-toggles').querySelectorAll('[data-channel]')];
    #filters = { status: '', channel: '' };
    #signature = '';
    #latest = { campaigns: null, selected: '' };

    constructor(onOpen) {
        this.onOpen = onOpen;
        for (const tab of this.#statusTabs) tab.addEventListener('click', () => this.#setFilter('status', tab.dataset.status));
        for (const toggle of this.#channelToggles) toggle.addEventListener('click', () => this.#toggleChannel(toggle.dataset.channel));
    }

    render(campaigns = this.#latest.campaigns, selected = this.#latest.selected) {
        this.#latest = { campaigns, selected };
        if (!campaigns) return;
        const visible = this.#renderTotals(campaigns).filter(campaign => this.#matchesStatus(campaign));
        this.#renderSummary(campaigns, visible);
        this.#renderRows(visible, selected);
    }

    clearFilters() {
        this.#filters = { status: '', channel: '' };
        this.render();
    }

    #setFilter(name, value) {
        this.#filters[name] = value;
        this.render();
    }

    #toggleChannel(channel) {
        this.#setFilter('channel', this.#filters.channel === channel ? '' : channel);
    }

    #renderTotals(campaigns) {
        const inChannel = campaigns.filter(campaign => !this.#filters.channel || campaign.channel === this.#filters.channel);
        const total = key => inChannel.reduce((sum, campaign) => sum + (campaign[key] ?? 0), 0);
        for (const key of TOTAL_METRICS) setMetric(key, total(key));
        showReviewCaption(total('unknown'));
        this.#renderFilterButtons();
        return inChannel;
    }

    #renderFilterButtons() {
        for (const tab of this.#statusTabs) tab.setAttribute('aria-pressed', String(tab.dataset.status === this.#filters.status));
        for (const toggle of this.#channelToggles) toggle.setAttribute('aria-pressed', String(toggle.dataset.channel === this.#filters.channel));
    }

    #matchesStatus(campaign) {
        const { status } = this.#filters;
        return !status || campaign[status] > 0 || (status === 'failed' && campaign.unknown > 0);
    }

    #renderSummary(campaigns, visible) {
        const filtered = campaigns.length > 0;
        const noun = campaigns.length === 1 ? 'campaign' : 'campaigns';
        const shown = visible.length === campaigns.length ? '' : `${number.format(visible.length)} of `;
        get('campaign-count').textContent = `${shown}${number.format(campaigns.length)} ${noun}`;
        get('campaign-table').hidden = visible.length === 0;
        get('campaign-empty').hidden = visible.length !== 0;
        renderEmptyState(filtered);
    }

    #renderRows(visible, selected) {
        const signature = JSON.stringify([selected, visible]);
        if (signature === this.#signature) return;
        this.#signature = signature;
        const focused = document.activeElement?.dataset.campaign;
        this.#rows.replaceChildren(...visible.map(campaign => this.#row(campaign, campaign.id === selected)));
        if (focused) this.#rows.querySelector(`[data-campaign="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
    }

    #row(campaign, selected) {
        const row = element('tr');
        row.classList.toggle('selected', selected);
        row.append(cell(this.#identity(campaign, selected)), cell(badge(statusOf(campaign))), progressCell(campaign),
            element('td', 'muted date-cell', formatDate(campaign.updatedAt)), this.#viewCell(campaign));
        return row;
    }

    #identity(campaign, selected) {
        const open = button(campaign.id, () => this.onOpen(campaign.id), 'campaign-link');
        open.dataset.campaign = campaign.id;
        open.setAttribute('aria-controls', 'details');
        open.setAttribute('aria-expanded', String(selected));
        const name = element('div');
        name.append(open, element('span', 'muted block', `${CHANNEL_LABELS[campaign.channel]}${campaign.isTest ? ' test' : ''}`));
        const identity = element('div', 'campaign-identity');
        identity.append(channelMark(campaign.channel), name);
        return identity;
    }

    #viewCell(campaign) {
        const view = button('View', () => this.onOpen(campaign.id), 'button ghost small', 'chevron-right');
        view.setAttribute('aria-label', `View ${campaign.id}`);
        return cell(view, 'open-cell');
    }
}

function cell(content, className) {
    const node = element('td', className);
    node.append(content);
    return node;
}

function progressCell(campaign) {
    const node = element('td', 'progress-cell');
    node.append(progressBar(campaign), element('span', 'muted block', progressText(campaign)));
    return node;
}

function setMetric(key, value) {
    const target = get(`metric-${key}`);
    const text = number.format(value);
    if (target.textContent === text) return;
    target.textContent = text;
    replayAnimation(target, 'changed');
}

function showReviewCaption(review) {
    const caption = get('metric-failed-caption');
    caption.textContent = review ? `${number.format(review)} to review` : '';
    caption.hidden = !review;
}

function renderEmptyState(hasCampaigns) {
    get('empty-heading').textContent = hasCampaigns ? 'No matching campaigns' : 'No campaigns yet';
    get('empty-copy').textContent = hasCampaigns ? 'Try clearing the filters.' : 'Import an Excel workbook to get started.';
    get('empty-action').textContent = hasCampaigns ? 'Clear filters' : 'New campaign';
}
