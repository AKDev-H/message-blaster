import { CHANNEL_LABELS } from '../shared/labels.mjs';
import { element, formFeedback, get, groupPath, request, sendJson, toast } from '../shared/ui.mjs';

const ACTIONS = {
    send: { title: 'Send both', done: 'Sending started' },
    start: { title: 'Start sending', done: 'Sending started' },
    resume: { title: 'Resume sending', done: 'Sending resumed' },
    pause: { title: 'Pause sending', copy: 'No new messages will be sent until you resume.', done: 'Sending paused' },
    cancel: { title: 'Cancel sending', copy: 'Recipients who have not been messaged yet will be skipped.', done: 'Sending cancelled', danger: true },
    retry: { title: 'Retry failed', copy: 'Failed recipients go back to the queue. Resume sending when you are ready.', done: 'Failed recipients requeued' },
    delete: { title: 'Delete campaign', copy: 'This permanently deletes the campaign, every channel and its recipients.', done: 'Campaign deleted', danger: true },
    review: { title: 'Review outcome', copy: 'Confirm whether the recipient received the message.', done: 'Outcome recorded' },
    rename: { title: 'Rename campaign', done: 'Campaign renamed' },
};

const needsApproval = action => ['send', 'start', 'resume'].includes(action);

export class ConfirmDialog {
    #dialog = get('confirm');
    #form = get('confirm-form');
    #submit = get('confirm-submit');
    #pending = null;

    constructor(onDone) {
        this.onDone = onDone;
        const field = name => this.#form.elements.namedItem(name);
        this.controls = { approve: field('approve'), outcome: field('outcome'), note: field('note'), name: field('name') };
        this.feedback = formFeedback(this.controls, 'confirm-error');
        this.#listen();
    }

    open(action, context) {
        this.#pending = { action, ...context };
        this.#form.reset();
        this.feedback.clear();
        this.#describe(this.#pending);
        if (action === 'rename') this.controls.name.value = context.name;
        this.#submit.className = ACTIONS[action].danger ? 'button danger' : 'button primary';
        this.#submit.textContent = title(this.#pending);
        this.#dialog.showModal();
    }

    #describe(pending) {
        const { action, slug } = pending;
        get('confirm-title').textContent = title(pending);
        const description = get('confirm-description');
        if (needsApproval(action)) description.replaceChildren('Type ', element('kbd', 'confirm-token', slug), ` to confirm. ${approvalCopy(pending)}`);
        else description.textContent = ACTIONS[action].copy ?? '';
        get('approve-field').hidden = !needsApproval(action);
        get('review-fields').hidden = action !== 'review';
        get('rename-field').hidden = action !== 'rename';
        get('confirm-body').hidden = !needsApproval(action) && !['review', 'rename'].includes(action);
    }

    #errors() {
        const { action, slug } = this.#pending;
        if (needsApproval(action)) return { approve: approvalError(this.controls.approve.value.trim(), slug) };
        if (action === 'review') return reviewErrors(this.controls.outcome.value, this.controls.note.value.trim());
        if (action === 'rename') return { name: nameError(this.controls.name.value.trim()) };
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

    async #perform(pending) {
        const { action, slug, channel } = pending;
        const base = groupPath(slug);
        if (action === 'delete') await request(base, { method: 'DELETE' });
        else if (action === 'rename') await sendJson(base, 'PATCH', { name: this.controls.name.value.trim() });
        else if (action === 'send') await sendJson(`${base}/send`, 'POST', { channels: pending.channels, ...this.#approval(pending) });
        else await sendJson(`${base}/${channel}/${action}`, 'POST', this.#body(pending));
        this.#dialog.close();
        toast(ACTIONS[action].done);
        await this.onDone(action, slug);
    }

    #approval(pending) {
        return { approve: this.controls.approve.value.trim(), version: pending.version() };
    }

    #body(pending) {
        if (pending.action === 'review') return { recordId: pending.recordId, outcome: this.controls.outcome.value, note: this.controls.note.value.trim() };
        return needsApproval(pending.action) ? this.#approval(pending) : {};
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

    #highlightMatch() {
        const token = get('confirm-description').querySelector('.confirm-token');
        token?.classList.toggle('matched', this.controls.approve.value.trim() === this.#pending?.slug);
    }

    #revalidate(name, control) {
        if (control.hasAttribute('aria-invalid')) this.feedback.show(name, this.#errors()[name]);
    }
}

function title({ action, channel, combined }) {
    const base = ACTIONS[action].title;
    return combined && channel ? `${base} · ${CHANNEL_LABELS[channel]}` : base;
}

function approvalCopy({ action, channels, channel, combined }) {
    if (action === 'send') return `${channels.map(name => CHANNEL_LABELS[name]).join(' sends first, then ')}. Messages go to real recipients.`;
    return combined ? `Only ${CHANNEL_LABELS[channel]} recipients are messaged. Messages go to real recipients.` : 'Messages will be sent to real recipients.';
}

function approvalError(value, slug) {
    if (!value) return 'Enter the campaign name.';
    return value === slug ? '' : `Enter “${slug}” exactly.`;
}

function nameError(name) {
    if (!name) return 'Enter a name.';
    return name.length > 100 ? 'Use 100 characters or fewer.' : '';
}

function reviewErrors(outcome, note) {
    const errors = { outcome: outcome ? '' : 'Choose an outcome.' };
    if (!note) errors.note = 'Add a short note.';
    else if (note.length > 1000) errors.note = 'Use 1,000 characters or fewer.';
    return errors;
}
