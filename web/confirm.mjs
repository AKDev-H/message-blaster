import { campaignPath, element, formFeedback, get, request, toast } from './ui.mjs';

const actions = {
    start: { title: 'Start sending', done: 'Sending started' },
    resume: { title: 'Resume sending', done: 'Sending resumed' },
    pause: { title: 'Pause campaign', copy: 'No new messages will be sent until you resume.', done: 'Campaign paused' },
    cancel: { title: 'Cancel campaign', copy: 'Recipients who have not been messaged yet will be skipped.', done: 'Campaign cancelled', danger: true },
    retry: { title: 'Retry failed', copy: 'Failed recipients go back to the queue. Resume sending when you are ready.', done: 'Failed recipients requeued' },
    delete: { title: 'Delete campaign', copy: 'This permanently deletes the campaign and its recipients.', done: 'Campaign deleted', danger: true },
    review: { title: 'Review outcome', copy: 'Confirm whether the recipient received the message.', done: 'Outcome recorded' },
};

const needsApproval = action => action === 'start' || action === 'resume';

export function createConfirm(onDone) {
    const dialog = get('confirm');
    const form = get('confirm-form');
    const field = name => form.elements.namedItem(name);
    const controls = { approve: field('approve'), outcome: field('outcome'), note: field('note') };
    const feedback = formFeedback(controls, 'confirm-error');
    const submit = get('confirm-submit');
    let pending = null;

    function validate() {
        const { action, id } = pending;
        const errors = {};
        if (needsApproval(action)) {
            const value = controls.approve.value.trim();
            if (!value) errors.approve = 'Enter the campaign name.';
            else if (value !== id) errors.approve = `Enter “${id}” exactly.`;
        }
        if (action === 'review') {
            if (!controls.outcome.value) errors.outcome = 'Choose an outcome.';
            const note = controls.note.value.trim();
            if (!note) errors.note = 'Add a short note.';
            else if (note.length > 1000) errors.note = 'Use 1,000 characters or fewer.';
        }
        return errors;
    }

    function open(action, campaign, recordId) {
        const config = actions[action];
        pending = { action, id: campaign.id, recordId };
        form.reset();
        feedback.clear();
        get('confirm-title').textContent = config.title;
        const description = get('confirm-description');
        if (needsApproval(action)) {
            description.replaceChildren('Type ', element('kbd', 'confirm-token', campaign.id),
                ' to confirm. Messages will be sent to real recipients.');
        } else {
            description.textContent = config.copy;
        }
        get('approve-field').hidden = !needsApproval(action);
        get('review-fields').hidden = action !== 'review';
        get('confirm-body').hidden = !needsApproval(action) && action !== 'review';
        submit.className = config.danger ? 'button danger' : 'button primary';
        submit.textContent = config.title;
        dialog.showModal();
    }

    async function send(event) {
        event.preventDefault();
        if (!pending || submit.disabled) return;
        feedback.clear();
        if (!feedback.validate(validate())) return;

        const { action, id, recordId } = pending;
        const body = action === 'review'
            ? { recordId, outcome: controls.outcome.value, note: controls.note.value.trim() }
            : needsApproval(action) ? { approve: controls.approve.value.trim() } : {};
        get('confirm-body').hidden = false;
        submit.disabled = true;
        form.setAttribute('aria-busy', 'true');
        try {
            if (action === 'delete') {
                await request(campaignPath(id), { method: 'DELETE' });
            } else {
                await request(`${campaignPath(id)}/${action}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                });
            }
            dialog.close();
            toast(actions[action].done);
            await onDone(action, id);
        } catch (error) {
            feedback.report(error);
        } finally {
            submit.disabled = false;
            form.removeAttribute('aria-busy');
        }
    }

    controls.approve.addEventListener('input', () => {
        const token = get('confirm-description').querySelector('.confirm-token');
        token?.classList.toggle('matched', controls.approve.value.trim() === pending?.id);
    });
    for (const [name, control] of Object.entries(controls)) {
        control.addEventListener(control.matches('select') ? 'change' : 'input', () => {
            if (control.hasAttribute('aria-invalid')) feedback.show(name, validate()[name]);
        });
    }
    form.addEventListener('submit', send);
    return { open };
}
