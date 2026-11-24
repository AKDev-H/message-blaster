import { channelMark } from '../shared/brands.mjs';
import { icon } from '../shared/icons.mjs';
import { CHANNEL_LABELS } from '../shared/labels.mjs';
import { button, element, get, number, replayAnimation, request } from '../shared/ui.mjs';
import { badge, formatDate, progressBar, progressText, statusOf } from './status.mjs';

const TOTAL_METRICS = ['queued', 'processing', 'completed', 'failed'];
const SKELETON_ROWS = 5;
const MIN_SKELETON_MS = 260;

export class CampaignQueue {
    #rows = get('campaign-rows');
    #statusTabs = [...get('status-tabs').querySelectorAll('[data-status]')];
    #channelToggles = [...get('channel-toggles').querySelectorAll('[data-channel]')];
    #filters = { status: '', channel: '' };
    #page = 1;
    #selected = '';
    #result = null;
    #signature = '';
    #loading = null;
    #refreshQueued = false;

    constructor({ onOpen, onLoad, onError }) {
        this.on = { open: onOpen, load: onLoad, error: onError };
        for (const tab of this.#statusTabs) tab.addEventListener('click', () => this.#setFilter('status', tab.dataset.status));
        for (const toggle of this.#channelToggles) toggle.addEventListener('click', () => this.#toggleChannel(toggle.dataset.channel));
        get('campaign-previous').addEventListener('click', () => this.#goTo(this.#page - 1));
        get('campaign-next').addEventListener('click', () => this.#goTo(this.#page + 1));
        this.#showSkeleton();
    }

    get hasCampaigns() {
        return (this.#result?.allCampaigns ?? 0) > 0;
    }

    load() {
        this.#loading?.controller.abort();
        this.#refreshQueued = false;
        this.#showSkeleton();
        return this.#fetch(true);
    }

    refresh() {
        if (this.#loading) {
            this.#refreshQueued = true;
            return this.#loading.promise;
        }
        return this.#fetch(false);
    }

    select(id) {
        this.#selected = id;
        if (this.#result) this.#renderRows(this.#result.campaigns);
    }

    clearFilters() {
        this.#filters = { status: '', channel: '' };
        this.#page = 1;
        this.#renderFilterButtons();
        return this.load();
    }

    #fetch(withSkeleton) {
        const controller = new AbortController();
        const started = performance.now();
        const promise = (async () => {
            try {
                const result = await request(`/api/campaigns?${this.#query()}`, { signal: controller.signal });
                if (withSkeleton) await holdSkeleton(started);
                if (controller.signal.aborted) return;
                this.#show(result, withSkeleton);
                this.on.load(result);
            } catch (error) {
                if (error.name === 'AbortError') return;
                if (withSkeleton) this.#restoreAfterFailure();
                this.on.error(error);
            } finally {
                if (this.#loading?.controller === controller) this.#loading = null;
            }
            if (this.#refreshQueued && !this.#loading) {
                this.#refreshQueued = false;
                await this.#fetch(false);
            }
        })();
        this.#loading = { controller, promise };
        return promise;
    }

    #query() {
        const params = new URLSearchParams({ page: String(this.#page) });
        for (const [key, value] of Object.entries(this.#filters)) if (value) params.set(key, value);
        return params;
    }

    #setFilter(name, value) {
        if (this.#filters[name] === value) return;
        this.#filters[name] = value;
        this.#page = 1;
        this.#renderFilterButtons();
        this.load();
    }

    #toggleChannel(channel) {
        this.#setFilter('channel', this.#filters.channel === channel ? '' : channel);
    }

    #goTo(page) {
        if (!this.#result || page < 1 || page > this.#result.totalPages || page === this.#page) return;
        this.#page = page;
        this.load();
    }

    #show(result, reveal) {
        this.#result = result;
        this.#page = result.page;
        for (const key of TOTAL_METRICS) setMetric(key, result.totals[key] ?? 0);
        showReviewCaption(result.totals.unknown);
        this.#renderSummary(result);
        this.#renderRows(result.campaigns, reveal);
        this.#renderPagination(result);
    }

    #restoreAfterFailure() {
        if (this.#result) return this.#show(this.#result, false);
        this.#rows.replaceChildren();
        this.#rows.removeAttribute('aria-busy');
        get('campaign-table').hidden = true;
    }

    #showSkeleton() {
        this.#signature = '';
        get('campaign-table').hidden = false;
        get('campaign-empty').hidden = true;
        this.#rows.setAttribute('aria-busy', 'true');
        this.#rows.classList.remove('reveal');
        const count = Math.min(SKELETON_ROWS, Math.max(1, this.#result?.campaigns.length || SKELETON_ROWS));
        this.#rows.replaceChildren(...Array.from({ length: count }, skeletonRow));
        get('campaign-pagination').classList.add('loading');
        for (const tab of this.#statusTabs) tab.classList.toggle('loading', !this.#result);
    }

    #renderFilterButtons() {
        for (const tab of this.#statusTabs) tab.setAttribute('aria-pressed', String(tab.dataset.status === this.#filters.status));
        for (const toggle of this.#channelToggles) toggle.setAttribute('aria-pressed', String(toggle.dataset.channel === this.#filters.channel));
    }

    #renderSummary({ matching, allCampaigns }) {
        const noun = allCampaigns === 1 ? 'campaign' : 'campaigns';
        const shown = matching === allCampaigns ? '' : `${number.format(matching)} of `;
        get('campaign-count').textContent = `${shown}${number.format(allCampaigns)} ${noun}`;
        get('campaign-table').hidden = matching === 0;
        get('campaign-empty').hidden = matching !== 0;
        renderEmptyState(allCampaigns > 0);
    }

    #renderRows(campaigns, reveal = false) {
        const signature = JSON.stringify([this.#selected, campaigns]);
        if (signature === this.#signature) return;
        this.#signature = signature;
        const focused = document.activeElement?.dataset.campaign;
        this.#rows.replaceChildren(...campaigns.map(campaign => this.#row(campaign, campaign.id === this.#selected)));
        this.#rows.removeAttribute('aria-busy');
        if (reveal) replayAnimation(this.#rows, 'reveal');
        for (const tab of this.#statusTabs) tab.classList.remove('loading');
        if (focused) this.#rows.querySelector(`[data-campaign="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
    }

    #renderPagination({ page, pageSize, totalPages, matching }) {
        const footer = get('campaign-pagination');
        footer.classList.remove('loading');
        footer.hidden = totalPages <= 1;
        if (footer.hidden) return;
        const first = ((page - 1) * pageSize) + 1;
        const last = Math.min(matching, page * pageSize);
        get('campaign-range').textContent = `Showing ${number.format(first)}–${number.format(last)} of ${number.format(matching)}`;
        get('campaign-previous').disabled = page <= 1;
        get('campaign-next').disabled = page >= totalPages;
        get('campaign-pages').replaceChildren(...pageWindow(page, totalPages).map(item => this.#pageButton(item, page)));
    }

    #pageButton(item, current) {
        if (item === 'gap') return element('span', 'page-gap', '…');
        const target = button(number.format(item), () => this.#goTo(item), 'page-button');
        target.setAttribute('aria-label', `Page ${item}`);
        if (item === current) target.setAttribute('aria-current', 'page');
        return target;
    }

    #row(campaign, selected) {
        const row = element('tr');
        row.classList.toggle('selected', selected);
        row.append(cell(this.#identity(campaign, selected)), cell(badge(statusOf(campaign))), progressCell(campaign),
            element('td', 'muted date-cell', formatDate(campaign.updatedAt)), this.#viewCell(campaign));
        return row;
    }

    #identity(campaign, selected) {
        const open = button(campaign.id, () => this.on.open(campaign.id), 'campaign-link');
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
        const view = button('View', () => this.on.open(campaign.id), 'button ghost small', 'chevron-right');
        view.setAttribute('aria-label', `View ${campaign.id}`);
        return cell(view, 'open-cell');
    }
}

function pageWindow(current, total) {
    const pages = [...new Set([1, current - 1, current, current + 1, total])].filter(page => page >= 1 && page <= total).sort((a, b) => a - b);
    return pages.flatMap((page, index) => (index > 0 && page - pages[index - 1] > 1 ? ['gap', page] : [page]));
}

async function holdSkeleton(started) {
    const remaining = MIN_SKELETON_MS - (performance.now() - started);
    if (remaining > 0 && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        await new Promise(resolve => setTimeout(resolve, remaining));
    }
}

function skeletonRow() {
    const row = element('tr', 'skeleton-row');
    row.setAttribute('aria-hidden', 'true');
    const identity = element('div', 'campaign-identity');
    const lines = element('div', 'skeleton-lines');
    lines.append(element('span', 'skeleton skeleton-line wide'), element('span', 'skeleton skeleton-line short'));
    identity.append(element('span', 'skeleton skeleton-mark'), lines);
    const progress = element('div', 'skeleton-lines');
    progress.append(element('span', 'skeleton skeleton-bar'), element('span', 'skeleton skeleton-line tiny'));
    row.append(cell(identity), cell(element('span', 'skeleton skeleton-pill')), cell(progress, 'progress-cell'),
        cell(element('span', 'skeleton skeleton-line short'), 'date-cell'), cell(element('span', 'skeleton skeleton-line tiny'), 'open-cell'));
    return row;
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
    get('empty-icon').replaceChildren(icon(hasCampaigns ? 'search-x' : 'megaphone', 22));
    get('empty-heading').textContent = hasCampaigns ? 'No matching campaigns' : 'No campaigns yet';
    get('empty-copy').textContent = hasCampaigns ? 'Try clearing the filters.' : 'Import an Excel workbook to get started.';
    const action = get('empty-action');
    action.querySelector('.icon')?.replaceWith(icon(hasCampaigns ? 'filter-x' : 'plus'));
    get('empty-action-label').textContent = hasCampaigns ? 'Clear filters' : 'New campaign';
}
