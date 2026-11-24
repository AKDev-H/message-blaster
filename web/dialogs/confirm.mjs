import { campaignPath, element, formFeedback, get, request, sendJson, toast } from '../shared/ui.mjs';

const ACTIONS = {
    start: { title: 'Start sending', done: 'Sending started' },
    resume: { title: 'Resume sending', done: 'Sending resumed' },
    pause: { title: 'Pause campaign', copy: 'No new messages will be sent until you resume.', done: 'Campaign paused' },
    cancel: { title: 'Cancel campaign', copy: 'Recipients who have not been messaged yet will be skipped.', done: 'Campaign cancelled', danger: true },
    retry: { title: 'Retry failed', copy: 'Failed recipients go back to the queue. Resume sending when you are ready.', done: 'Failed recipients requeued' },
    delete: { title: 'Delete campaign', copy: 'This permanently deletes the campaign and its recipients.', done: 'Campaign deleted', danger: true },
    review: { title: 'Review outcome', copy: 'Confirm whether the recipient received the message.', done: 'Outcome recorded' },
};

/** Sending to real recipients requires typing the campaign name. */
const needsApproval = action => action === 'start' || action === 'resume';

/** Asks before any campaign action, collecting approval or a review when needed. `onDone(action, id)` runs after success. */
export class ConfirmDialog {
    #dialog = get('confirm');
    #form = get('confirm-form');
    #submit = get('confirm-submit');
    #pending = null;

    constructor(onDone) {
        this.onDone = onDone;
        const field = name => this.#form.elements.namedItem(name);
        this.controls = { approve: field('approve'), outcome: field('outcome'), note: field('note') };
        this.feedback = formFeedback(this.controls, 'confirm-error');
        this.#listen();
    }

    open(action, campaign, recordId) {
        this.#pending = { action, id: campaign.id, recordId };
        this.#form.reset();
        this.feedback.clear();
        this.#describe(action, campaign.id);
        this.#submit.className = ACTIONS[action].danger ? 'button danger' : 'button primary';
        this.#submit.textContent = ACTIONS[action].title;
        this.#dialog.showModal();
    }

    #describe(action, id) {
        get('confirm-title').textContent = ACTIONS[action].title;
        const description = get('confirm-description');
        if (needsApproval(action)) description.replaceChildren('Type ', element('kbd', 'confirm-token', id), ' to confirm. Messages will be sent to real recipients.');
        else description.textContent = ACTIONS[action].copy;
        get('approve-field').hidden = !needsApproval(action);
        get('review-fields').hidden = action !== 'review';
        get('confirm-body').hidden = !needsApproval(action) && action !== 'review';
    }

    #errors() {
        const { action, id } = this.#pending;
        if (needsApproval(action)) return { approve: approvalError(this.controls.approve.value.trim(), id) };
        if (action === 'review') return reviewErrors(this.controls.outcome.value, this.controls.note.value.trim());
        return {};
    }

    async #send(event) {
        event.preventDefault();
        if (!this.#pending || this.#submit.disabled) return;
        this.feedback.clear();
        if (!this.feedback.validate(this.#errors())) return;
        get('confirm-body').hidden = false;
        this.#setBusy(true);
        try {
            await this.#perform(this.#pending);
        } catch (error) {
            this.feedback.report(error);
        } finally {
            this.#setBusy(false);
        }
    }

    async #perform({ action, id, recordId }) {
        if (action === 'delete') await request(campaignPath(id), { method: 'DELETE' });
        else await sendJson(`${campaignPath(id)}/${action}`, 'POST', this.#body(action, recordId));
        this.#dialog.close();
        toast(ACTIONS[action].done);
        await this.onDone(action, id);
    }

    #body(action, recordId) {
        if (action === 'review') return { recordId, outcome: this.controls.outcome.value, note: this.controls.note.value.trim() };
        return needsApproval(action) ? { approve: this.controls.approve.value.trim() } : {};
    }

    #setBusy(busy) {
        this.#submit.disabled = busy;
        if (busy) this.#form.setAttribute('aria-busy', 'true');
        else this.#form.removeAttribute('aria-busy');
    }

    #listen() {
        this.controls.approve.addEventListener('input', () => this.#highlightMatch());
        for (const [name, control] of Object.entries(this.controls)) {
            control.addEventListener(control.matches('select') ? 'change' : 'input', () => this.#revalidate(name, control));
        }
        this.#form.addEventListener('submit', event => this.#send(event));
    }

    /** The campaign name turns green once typed correctly. */
    #highlightMatch() {
        const token = get('confirm-description').querySelector('.confirm-token');
        token?.classList.toggle('matched', this.controls.approve.value.trim() === this.#pending?.id);
    }

    #revalidate(name, control) {
        if (control.hasAttribute('aria-invalid')) this.feedback.show(name, this.#errors()[name]);
    }
}

function approvalError(value, id) {
    if (!value) return 'Enter the campaign name.';
    return value === id ? '' : `Enter “${id}” exactly.`;
}

function reviewErrors(outcome, note) {
    const errors = { outcome: outcome ? '' : 'Choose an outcome.' };
    if (!note) errors.note = 'Add a short note.';
    else if (note.length > 1000) errors.note = 'Use 1,000 characters or fewer.';
    return errors;
}
