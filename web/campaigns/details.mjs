import { channelMark } from '../shared/brands.mjs';
import { CHANNEL_LABELS, plural } from '../shared/labels.mjs';
import { campaignPath, element, get, number, request, setError } from '../shared/ui.mjs';
import { actionContext, actionSignature, campaignActions } from './actions.mjs';
import { emptyRecipientRow, recipientRow } from './recipient-rows.mjs';
import { badge, COUNT_KEYS, COUNT_LABELS, statusOf } from './status.mjs';

/**
 * The panel for one campaign: header, action buttons, counts and a page of recipients.
 * `on` has edit(detail), action(name, campaign, recordId), viewAttachment(name) and close(id).
 */
export class CampaignDetails {
    #panel = get('details');
    #actions = get('detail-actions');
    #recipientRows = get('detail-rows');
    #selected = '';
    #page = 1;
    #detail = null;
    #pendingRequest = null;
    #overview = { campaigns: [], dryRun: true };

    constructor(on) {
        this.on = on;
        get('close-detail').addEventListener('click', () => this.#closeByUser());
        get('previous-page').addEventListener('click', () => this.#turnPage(-1));
        get('next-page').addEventListener('click', () => this.#turnPage(1));
    }

    get selected() {
        return this.#selected;
    }

    open(id) {
        if (this.#selected !== id) this.#reset(id);
        setError('detail-error', '');
        this.#panel.hidden = false;
        get('detail-heading').focus({ preventScroll: true });
        this.#panel.scrollIntoView({ block: 'start', behavior: 'smooth' });
        return this.reload();
    }

    close() {
        this.#pendingRequest?.abort();
        this.#pendingRequest = null;
        this.#detail = null;
        this.#selected = '';
        this.#panel.hidden = true;
    }

    /** Called with every live snapshot. Reloads only when this campaign changed. */
    update(overview, changed) {
        this.#overview = overview;
        if (!this.#selected) return;
        const current = overview.campaigns.find(campaign => campaign.id === this.#selected);
        if (!current) this.#closeBecauseDeleted();
        else if (changed(current)) this.reload();
        else if (this.#detail) this.#renderHeader();
    }

    /** Loads the current page. A newer request cancels an older one still in flight. */
    async reload() {
        if (!this.#selected) return;
        this.#pendingRequest?.abort();
        const loading = new AbortController();
        this.#pendingRequest = loading;
        try {
            this.#show(await request(`${campaignPath(this.#selected)}?page=${this.#page}`, { signal: loading.signal }), loading);
        } catch (error) {
            if (error.name !== 'AbortError' && this.#pendingRequest === loading) this.#showLoadError(error);
        }
    }

    #show(result, loading) {
        if (this.#pendingRequest !== loading) return;
        this.#detail = result;
        this.#page = result.page;
        this.#render();
    }

    #showLoadError(error) {
        this.#page = this.#detail?.page ?? 1;
        paginate(this.#page, this.#detail?.totalPages ?? 1);
        setError('detail-error', error);
    }

    #reset(id) {
        this.#selected = id;
        this.#page = 1;
        this.#detail = null;
        get('detail-heading').textContent = id;
        get('detail-description').textContent = 'Loading…';
        for (const key of ['detail-state', 'detail-actions', 'detail-rows', 'detail-summary', 'page-number']) get(key).replaceChildren();
        delete this.#actions.dataset.signature;
        paginate(1, 1);
    }

    #render() {
        this.#renderHeader();
        this.#renderCounts(this.#detail.campaign);
        this.#renderRecipients(this.#detail);
        paginate(this.#detail.page, this.#detail.totalPages);
    }

    /** The header uses the live snapshot, which is newer than the loaded page. */
    #renderHeader() {
        const { campaign } = this.#detail;
        const latest = this.#overview.campaigns.find(row => row.id === campaign.id) ?? campaign;
        get('detail-heading').textContent = campaign.id;
        get('detail-state').replaceChildren(badge(statusOf(latest)));
        const description = `${CHANNEL_LABELS[campaign.channel]}${campaign.isTest ? ' test' : ''}, ${plural(latest.total, 'recipient', 'recipients')}`;
        get('detail-description').replaceChildren(channelMark(campaign.channel), element('span', '', description));
        setError('detail-error', latest.runError || '');
        this.#renderActions(actionContext(this.#detail, latest, this.#overview));
    }

    /** Buttons are rebuilt only when they would change, keeping focus on the one the user was on. */
    #renderActions(context) {
        const signature = actionSignature(context);
        if (this.#actions.dataset.signature === signature) return;
        const focused = this.#actions.contains(document.activeElement) ? document.activeElement.textContent : '';
        const buttons = campaignActions(context, { edit: () => this.on.edit(this.#detail), action: this.on.action });
        this.#actions.dataset.signature = signature;
        this.#actions.replaceChildren(...buttons);
        if (focused) buttons.find(node => node.textContent === focused)?.focus({ preventScroll: true });
    }

    #renderCounts(campaign) {
        const shown = COUNT_KEYS.filter(key => campaign[key] || key === 'queued');
        get('detail-summary').replaceChildren(...shown.map(key => countTile(key, campaign[key] ?? 0)));
    }

    #renderRecipients({ campaign, rows }) {
        const opened = new Set([...this.#recipientRows.querySelectorAll('.message-body[open]')].map(node => node.dataset.record));
        const on = { review: recordId => this.on.action('review', campaign, recordId), viewAttachment: this.on.viewAttachment };
        const content = rows.map(record => recipientRow(record, opened, on));
        this.#recipientRows.replaceChildren(...(content.length ? content : [emptyRecipientRow()]));
    }

    #turnPage(direction) {
        if (!this.#detail) return;
        this.#page = this.#detail.page + direction;
        paginate(this.#page, 0);
        this.reload();
    }

    #closeByUser() {
        const id = this.#selected;
        this.close();
        this.on.close(id);
    }

    #closeBecauseDeleted() {
        this.close();
        this.on.close();
    }
}

function countTile(key, value) {
    const node = element('div', `detail-count ${key}`);
    node.append(element('strong', '', number.format(value)), element('span', '', COUNT_LABELS[key]));
    return node;
}

function paginate(current, total) {
    get('page-number').textContent = `${number.format(current)} / ${number.format(Math.max(1, total))}`;
    get('previous-page').disabled = current <= 1;
    get('next-page').disabled = current >= total;
}
