import { icon } from './icons.mjs';
import { element, request, setError, toast } from './ui.mjs';

const copy = {
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

const post = (path, body) => request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });

export function createTestSend(container, channel, onChange) {
    const text = copy[channel];
    const errorId = `${channel}-test-error`;
    const badge = element('span', 'test-badge');
    const help = element('p', 'field-help');
    const input = element('input');
    Object.assign(input, { type: text.type, placeholder: text.placeholder, autocomplete: 'off', spellcheck: false });
    input.setAttribute('aria-label', `Send the test ${text.noun} to`);
    input.setAttribute('aria-describedby', errorId);
    const send = element('button', 'button secondary');
    send.type = 'button';
    send.append(icon('send'), element('span', 'label', 'Send test'));
    const status = element('p', 'test-send-status');
    status.setAttribute('role', 'status');
    const confirm = element('button', 'button primary small');
    confirm.type = 'button';
    confirm.append(icon('mail-check'), element('span', 'label', 'I received it'));
    const result = element('div', 'test-send-result');
    result.append(status, confirm);
    const error = element('p', 'field-error');
    error.id = errorId;
    error.setAttribute('aria-live', 'polite');
    error.hidden = true;
    const head = element('div', 'test-send-head');
    head.append(element('strong', '', 'Test send'), badge);
    const row = element('div', 'test-send-row');
    row.append(input, send);
    container.replaceChildren(head, help, row, result, error);

    let edited = false;
    let busy = false;

    async function act(button, action, done) {
        if (busy) return;
        busy = true;
        button.classList.add('busy');
        setError(errorId, '');
        input.removeAttribute('aria-invalid');
        try {
            onChange(await action());
            if (done) toast(done);
        } catch (failure) {
            setError(errorId, failure);
            if (failure.field === 'testRecipient') {
                input.setAttribute('aria-invalid', 'true');
                input.focus();
            }
        } finally {
            busy = false;
            button.classList.remove('busy');
        }
    }

    function sendTest() {
        act(send, () => post(`/api/settings/${channel}/test`, { recipient: input.value.trim() }));
    }

    send.addEventListener('click', sendTest);
    confirm.addEventListener('click', () => act(confirm, () => post(`/api/settings/${channel}/test/confirm`), 'Test confirmed. Campaigns can start.'));
    input.addEventListener('input', () => {
        edited = true;
        input.removeAttribute('aria-invalid');
    });
    input.addEventListener('keydown', event => {
        if (event.key !== 'Enter' || event.isComposing) return;
        event.preventDefault();
        sendTest();
    });

    return {
        reset() {
            edited = false;
            setError(errorId, '');
            input.removeAttribute('aria-invalid');
        },
        render({ dryRun, test, fallbackRecipient = '' }) {
            const latest = test.latest?.current ? test.latest : null;
            const sending = latest?.phase === 'sending';
            const awaiting = latest?.phase === 'sent' && !latest.confirmed && !test.confirmed;
            const unavailable = !test.account;

            badge.textContent = test.confirmed ? 'Confirmed' : 'Required';
            badge.dataset.state = test.confirmed ? 'confirmed' : 'required';
            help.textContent = unavailable ? text.unavailable
                : dryRun ? 'Live sending is off. Set DRY_RUN=false in .env, then restart the dashboard.'
                    : test.confirmed ? 'This account is confirmed. Campaigns can start.' : text.required;
            if (!edited) input.value = latest?.recipient || input.value || fallbackRecipient;
            input.disabled = unavailable || dryRun || sending;
            send.disabled = input.disabled;
            send.querySelector('.label').textContent = latest && !sending ? 'Send again' : 'Send test';

            result.hidden = !(sending || awaiting || latest?.phase === 'failed');
            result.dataset.phase = latest?.phase ?? '';
            confirm.hidden = !awaiting;
            status.textContent = sending ? `Sending a test ${text.noun} to ${latest.recipient}…`
                : awaiting ? `Sent to ${latest.recipient}. ${text.check}`
                    : latest?.phase === 'failed' ? `The test didn’t go through: ${latest.error}` : '';
            return sending;
        },
    };
}
