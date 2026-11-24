import { icon } from '../shared/icons.mjs';
import { element, sendJson, setError, toast } from '../shared/ui.mjs';

const COPY = {
    gmail: {
        noun: 'email',
        type: 'email',
        placeholder: 'you@example.com',
        unavailable: 'Save your Gmail address and App Password first.',
        required: 'Before campaigns can start, send yourself a test email and confirm it arrived.',
        check: 'Check the inbox (and spam folder), then confirm.',
    },
    whatsapp: {
        noun: 'message',
        type: 'tel',
        placeholder: '+60 12 345 6789',
        unavailable: 'Link WhatsApp first.',
        required: 'Before campaigns can start, send a test message to a phone you can check and confirm it arrived.',
        check: 'Check the phone, then confirm.',
    },
};

export class TestSend {
    #edited = false;
    #busy = false;

    constructor(container, channel, onChange) {
        this.channel = channel;
        this.copy = COPY[channel];
        this.onChange = onChange;
        this.errorId = `${channel}-test-error`;
        this.#build(container);
        this.#listen();
    }

    reset() {
        this.#edited = false;
        this.#clearError();
    }

    render({ dryRun, test, fallbackRecipient = '' }) {
        const latest = test.latest?.current ? test.latest : null;
        const sending = latest?.phase === 'sending';
        const awaiting = latest?.phase === 'sent' && !latest.confirmed && !test.confirmed;
        this.#renderStatus(test, dryRun);
        this.#renderInput(test, dryRun, latest, sending, fallbackRecipient);
        this.#renderResult(latest, sending, awaiting);
        return sending;
    }

    #build(container) {
        this.badge = element('span', 'test-badge');
        this.help = element('p', 'field-help');
        this.input = this.#recipientInput();
        this.send = actionButton('button secondary', 'send', 'Send test');
        this.status = element('p', 'test-send-status');
        this.status.setAttribute('role', 'status');
        this.confirm = actionButton('button primary small', 'mail-check', 'I received it');
        container.replaceChildren(this.#head(), this.help, this.#row(), this.#result(), this.#errorLine());
    }

    #recipientInput() {
        const input = element('input');
        Object.assign(input, { type: this.copy.type, placeholder: this.copy.placeholder, autocomplete: 'off', spellcheck: false });
        input.setAttribute('aria-label', `Send the test ${this.copy.noun} to`);
        input.setAttribute('aria-describedby', this.errorId);
        return input;
    }

    #head() {
        const head = element('div', 'test-send-head');
        head.append(element('strong', '', 'Test send'), this.badge);
        return head;
    }

    #row() {
        const row = element('div', 'test-send-row');
        row.append(this.input, this.send);
        return row;
    }

    #result() {
        this.result = element('div', 'test-send-result');
        this.result.append(this.status, this.confirm);
        return this.result;
    }

    #errorLine() {
        const error = element('p', 'field-error');
        error.id = this.errorId;
        error.setAttribute('aria-live', 'polite');
        error.hidden = true;
        return error;
    }

    #listen() {
        this.send.addEventListener('click', () => this.#sendTest());
        this.confirm.addEventListener('click', () => this.#confirmTest());
        this.input.addEventListener('input', () => this.#onType());
        this.input.addEventListener('keydown', event => this.#onKey(event));
    }

    #sendTest() {
        this.#act(this.send, () => sendJson(`/api/settings/${this.channel}/test`, 'POST', { recipient: this.input.value.trim() }));
    }

    #confirmTest() {
        this.#act(this.confirm, () => sendJson(`/api/settings/${this.channel}/test/confirm`, 'POST'), 'Test confirmed. Campaigns can start.');
    }

    async #act(control, action, done) {
        if (this.#busy) return;
        this.#busy = true;
        control.classList.add('busy');
        this.#clearError();
        try {
            this.onChange(await action());
            if (done) toast(done);
        } catch (failure) {
            this.#showError(failure);
        } finally {
            this.#busy = false;
            control.classList.remove('busy');
        }
    }

    #showError(failure) {
        setError(this.errorId, failure);
        if (failure.field !== 'testRecipient') return;
        this.input.setAttribute('aria-invalid', 'true');
        this.input.focus();
    }

    #clearError() {
        setError(this.errorId, '');
        this.input.removeAttribute('aria-invalid');
    }

    #onType() {
        this.#edited = true;
        this.input.removeAttribute('aria-invalid');
    }

    #onKey(event) {
        if (event.key !== 'Enter' || event.isComposing) return;
        event.preventDefault();
        this.#sendTest();
    }

    #renderStatus(test, dryRun) {
        this.badge.textContent = test.confirmed ? 'Confirmed' : 'Required';
        this.badge.dataset.state = test.confirmed ? 'confirmed' : 'required';
        this.help.textContent = this.#helpText(test, dryRun);
    }

    #helpText(test, dryRun) {
        if (!test.account) return this.copy.unavailable;
        if (dryRun) return 'Live sending is off. Set DRY_RUN=false in .env, then restart the dashboard.';
        return test.confirmed ? 'This account is confirmed. Campaigns can start.' : this.copy.required;
    }

    #renderInput(test, dryRun, latest, sending, fallbackRecipient) {
        if (!this.#edited) this.input.value = latest?.recipient || this.input.value || fallbackRecipient;
        this.input.disabled = !test.account || dryRun || sending;
        this.send.disabled = this.input.disabled;
        this.send.querySelector('.label').textContent = latest && !sending ? 'Send again' : 'Send test';
    }

    #renderResult(latest, sending, awaiting) {
        this.result.hidden = !(sending || awaiting || latest?.phase === 'failed');
        this.result.dataset.phase = latest?.phase ?? '';
        this.confirm.hidden = !awaiting;
        this.status.textContent = this.#resultText(latest, sending, awaiting);
    }

    #resultText(latest, sending, awaiting) {
        if (sending) return `Sending a test ${this.copy.noun} to ${latest.recipient}…`;
        if (awaiting) return `Sent to ${latest.recipient}. ${this.copy.check}`;
        return latest?.phase === 'failed' ? `The test didn’t go through: ${latest.error}` : '';
    }
}

function actionButton(className, iconName, label) {
    const node = element('button', className);
    node.type = 'button';
    node.append(icon(iconName), element('span', 'label', label));
    return node;
}
