import { createTestSend } from './test-send.mjs';
import { formFeedback, get, request, setError, toast } from './ui.mjs';

const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
const pollMs = 2_000;

export function createSettings() {
    const dialog = get('settings');
    const tabs = [...dialog.querySelectorAll('[role="tab"]')];
    const gmailForm = get('panel-gmail');
    const sendingForm = get('panel-sending');
    const gmail = { gmailUser: get('gmail-user'), gmailPassword: get('gmail-password') };
    const sending = { country: get('sending-country'), delay: get('sending-delay') };
    const gmailFeedback = formFeedback(gmail, 'gmail-error');
    const sendingFeedback = formFeedback(sending, 'sending-error');
    const regionNames = new Intl.DisplayNames(undefined, { type: 'region' });
    let current = null;
    let pollTimer = 0;
    const tests = {
        gmail: createTestSend(get('gmail-test'), 'gmail', settings => render(settings, { forms: false })),
        whatsapp: createTestSend(get('whatsapp-test'), 'whatsapp', settings => render(settings, { forms: false })),
    };

    function selectTab(name) {
        for (const tab of tabs) {
            const selected = tab.dataset.tab === name;
            tab.setAttribute('aria-selected', String(selected));
            tab.tabIndex = selected ? 0 : -1;
            get(tab.getAttribute('aria-controls')).hidden = !selected;
        }
    }

    function renderCountries(countries, selected) {
        if (sending.country.options.length !== countries.length) {
            const options = countries
                .map(code => [code, regionNames.of(code) ?? code])
                .sort((a, b) => a[1].localeCompare(b[1]))
                .map(([code, name]) => new Option(`${name} (${code})`, code));
            sending.country.replaceChildren(...options);
        }
        sending.country.value = selected;
    }

    function renderWhatsApp({ status, account, qr, error }) {
        const card = get('whatsapp-status');
        card.dataset.status = status;
        const copy = {
            unlinked: ['Not linked', 'Link the phone number you send campaigns from.'],
            pairing: ['Waiting for your phone', 'In WhatsApp, open Settings › Linked devices › Link a device, then scan this code.'],
            linked: [`Linked to ${account ?? 'your number'}`, 'Campaigns send from this number.'],
            loggedOut: ['Logged out on the phone', 'Unlink this session, then link the number again.'],
        }[status];
        get('whatsapp-state').textContent = copy[0];
        get('whatsapp-copy').textContent = copy[1];
        const code = get('whatsapp-qr');
        code.hidden = status !== 'pairing';
        get('whatsapp-qr-wait').hidden = Boolean(qr);
        const image = get('whatsapp-qr-image');
        image.hidden = !qr;
        if (qr && image.getAttribute('src') !== qr) image.src = qr;
        get('whatsapp-link').hidden = status !== 'unlinked';
        get('whatsapp-cancel').hidden = status !== 'pairing';
        get('whatsapp-unlink').hidden = status !== 'linked' && status !== 'loggedOut';
        setError('whatsapp-error', error ?? '');
    }

    function render(settings, { forms = true } = {}) {
        current = settings;
        if (forms) renderForms(settings);
        renderWhatsApp(settings.whatsapp);

        const linked = settings.whatsapp.status === 'linked';
        get('whatsapp-test').hidden = !linked;
        const testing = [
            tests.gmail.render({ dryRun: settings.dryRun, test: settings.gmail.test, fallbackRecipient: settings.gmail.user }),
            linked && tests.whatsapp.render({ dryRun: settings.dryRun, test: settings.whatsapp.test }),
        ].some(Boolean);
        window.clearTimeout(pollTimer);
        if ((testing || settings.whatsapp.status === 'pairing') && dialog.open) pollTimer = window.setTimeout(poll, pollMs);
    }

    function renderForms(settings) {
        gmail.gmailUser.value = settings.gmail.user;
        gmail.gmailPassword.value = '';
        gmail.gmailPassword.placeholder = settings.gmail.passwordSet ? 'Saved. Leave blank to keep it.' : '16-character App Password';
        get('gmail-password-help').textContent = settings.gmail.passwordUnreadable
            ? 'The saved App Password can’t be read on this computer. Enter it again.'
            : 'Requires 2-Step Verification on the Google account. Saved encrypted.';
        get('gmail-verify').disabled = !settings.gmail.user || !settings.gmail.passwordSet;
        renderCountries(settings.countries, settings.sending.country);
        sending.delay.value = String(settings.sending.delaySeconds);
    }

    async function refresh(options) {
        try {
            render(await request('/api/settings'), options);
        } catch (error) {
            setError('settings-error', error);
        }
    }

    const poll = () => refresh({ forms: false });

    async function submit(button, action) {
        if (button.disabled) return;
        button.disabled = true;
        button.classList.add('busy');
        try {
            await action();
        } finally {
            button.disabled = false;
            button.classList.remove('busy');
        }
    }

    function validateGmail() {
        const errors = {};
        const user = gmail.gmailUser.value.trim();
        const password = gmail.gmailPassword.value.replaceAll(/\s/gu, '');
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(user)) errors.gmailUser = 'Enter the Gmail address you send from.';
        if (!password && !current?.gmail.passwordSet) errors.gmailPassword = 'Enter the 16-character App Password.';
        else if (password && !/^[a-z0-9]{16}$/iu.test(password)) errors.gmailPassword = 'An App Password has 16 letters and numbers.';
        return errors;
    }

    gmailForm.addEventListener('submit', event => {
        event.preventDefault();
        gmailFeedback.clear();
        get('gmail-status').hidden = true;
        if (!gmailFeedback.validate(validateGmail())) return;
        submit(get('gmail-save'), async () => {
            try {
                render(await request('/api/settings/gmail', json('PUT', {
                    user: gmail.gmailUser.value.trim(),
                    password: gmail.gmailPassword.value,
                })));
                toast('Gmail settings saved');
            } catch (error) {
                gmailFeedback.report(error);
            }
        });
    });

    get('gmail-verify').addEventListener('click', event => submit(event.currentTarget, async () => {
        gmailFeedback.clear();
        const status = get('gmail-status');
        status.hidden = true;
        try {
            await request('/api/settings/gmail/verify', json('POST'));
            status.hidden = false;
        } catch (error) {
            setError('gmail-error', error);
        }
    }));

    sendingForm.addEventListener('submit', event => {
        event.preventDefault();
        sendingFeedback.clear();
        const seconds = Number(sending.delay.value);
        const errors = {};
        if (!sending.country.value) errors.country = 'Choose a country.';
        if (sending.delay.value.trim() === '' || !Number.isFinite(seconds) || seconds < 0 || seconds > 3600) {
            errors.delay = 'Use 0–3,600 seconds.';
        }
        if (!sendingFeedback.validate(errors)) return;
        submit(get('sending-save'), async () => {
            try {
                render(await request('/api/settings/sending', json('PUT', { country: sending.country.value, delaySeconds: seconds })));
                toast('Sending settings saved');
            } catch (error) {
                sendingFeedback.report(error);
            }
        });
    });

    for (const [id, path, method] of [
        ['whatsapp-link', '/api/settings/whatsapp/link', 'POST'],
        ['whatsapp-cancel', '/api/settings/whatsapp/link', 'DELETE'],
        ['whatsapp-unlink', '/api/settings/whatsapp/unlink', 'POST'],
    ]) {
        get(id).addEventListener('click', event => submit(event.currentTarget, async () => {
            setError('whatsapp-error', '');
            try {
                render(await request(path, json(method)));
                if (id === 'whatsapp-unlink') toast('WhatsApp unlinked');
            } catch (error) {
                setError('whatsapp-error', error);
            }
        }));
    }

    for (const tab of tabs) tab.addEventListener('click', () => selectTab(tab.dataset.tab));
    get('settings-tabs').addEventListener('keydown', event => {
        if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
        const index = tabs.findIndex(tab => tab.getAttribute('aria-selected') === 'true');
        const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
        selectTab(next.dataset.tab);
        next.focus();
    });
    dialog.addEventListener('close', () => window.clearTimeout(pollTimer));

    return {
        open(tab = 'gmail') {
            setError('settings-error', '');
            gmailFeedback.clear();
            sendingFeedback.clear();
            get('gmail-status').hidden = true;
            for (const test of Object.values(tests)) test.reset();
            selectTab(tab);
            dialog.showModal();
            refresh();
        },
    };
}
