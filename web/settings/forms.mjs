import { formFeedback, get, sendJson, setError, toast, whileBusy } from '../shared/ui.mjs';

const regionNames = new Intl.DisplayNames(undefined, { type: 'region' });

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const HOST_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/iu;
const DEFAULT_PORTS = { starttls: 587, tls: 465 };

export class EmailForm {
    #fields = {
        gmailUser: get('gmail-user'),
        gmailPassword: get('gmail-password'),
        smtpHost: get('smtp-host'),
        smtpPort: get('smtp-port'),
        smtpSecurity: get('smtp-security'),
        smtpUser: get('smtp-user'),
        smtpPassword: get('smtp-password'),
        smtpFrom: get('smtp-from'),
    };
    #fromName = get('smtp-from-name');
    #providers = [...document.querySelectorAll('input[name="emailProvider"]')];
    #feedback = formFeedback(this.#fields, 'gmail-error');
    #saved = { provider: 'gmail', gmail: false, smtp: false, ready: false };

    constructor(onSaved) {
        this.onSaved = onSaved;
        get('panel-gmail').addEventListener('submit', event => this.#save(event));
        get('gmail-verify').addEventListener('click', event => whileBusy(event.currentTarget, () => this.#verify()));
        for (const radio of this.#providers) radio.addEventListener('change', () => this.#showProvider());
        this.#fields.smtpSecurity.addEventListener('change', () => this.#suggestPort());
    }

    get #provider() {
        return this.#providers.find(radio => radio.checked)?.value ?? 'gmail';
    }

    fill({ gmail }) {
        const { smtp } = gmail;
        this.#saved = { provider: gmail.provider, gmail: gmail.passwordSet, smtp: smtp.passwordSet, ready: gmail.test.account !== null };
        for (const radio of this.#providers) radio.checked = radio.value === gmail.provider;
        this.#fillGmail(gmail);
        this.#fillSmtp(smtp);
        this.#showProvider();
    }

    reset() {
        this.#feedback.clear();
        get('gmail-status').hidden = true;
    }

    #fillGmail(gmail) {
        this.#fields.gmailUser.value = gmail.user;
        this.#fields.gmailPassword.value = '';
        this.#fields.gmailPassword.placeholder = gmail.passwordSet ? 'Saved. Leave blank to keep it.' : '16-character App Password';
        get('gmail-password-help').textContent = gmail.passwordUnreadable
            ? 'The saved App Password can’t be read on this computer. Enter it again.'
            : 'Requires 2-Step Verification on the Google account. Saved encrypted.';
    }

    #fillSmtp(smtp) {
        this.#fields.smtpHost.value = smtp.host;
        this.#fields.smtpPort.value = String(smtp.port);
        this.#fields.smtpSecurity.value = smtp.security;
        this.#fields.smtpUser.value = smtp.user;
        this.#fields.smtpPassword.value = '';
        this.#fields.smtpPassword.placeholder = smtp.passwordSet ? 'Saved. Leave blank to keep it.' : '';
        this.#fields.smtpFrom.value = smtp.from;
        this.#fromName.value = smtp.fromName;
        get('smtp-password-help').textContent = smtp.passwordUnreadable
            ? 'The saved password can’t be read on this computer. Enter it again.'
            : 'Saved encrypted.';
    }

    #showProvider() {
        const provider = this.#provider;
        get('provider-gmail').hidden = provider !== 'gmail';
        get('provider-smtp').hidden = provider !== 'smtp';
        get('gmail-verify').disabled = provider !== this.#saved.provider || !this.#saved.ready;
        get('gmail-status-text').textContent = provider === 'smtp' ? 'The SMTP server accepted these details.' : 'Gmail accepted these details.';
        this.reset();
    }

    #suggestPort() {
        const port = Number(this.#fields.smtpPort.value);
        if (!port || Object.values(DEFAULT_PORTS).includes(port)) this.#fields.smtpPort.value = String(DEFAULT_PORTS[this.#fields.smtpSecurity.value]);
    }

    #save(event) {
        event.preventDefault();
        this.reset();
        if (!this.#feedback.validate(this.#errors())) return;
        whileBusy(get('gmail-save'), () => this.#send());
    }

    async #send() {
        try {
            this.onSaved(await sendJson('/api/settings/gmail', 'PUT', this.#body()));
            toast('Email settings saved');
        } catch (error) {
            this.#feedback.report(error);
        }
    }

    #body() {
        const f = this.#fields;
        return {
            provider: this.#provider,
            gmail: { user: f.gmailUser.value.trim(), password: f.gmailPassword.value },
            smtp: {
                host: f.smtpHost.value.trim(),
                port: Number(f.smtpPort.value),
                security: f.smtpSecurity.value,
                user: f.smtpUser.value.trim(),
                password: f.smtpPassword.value,
                from: f.smtpFrom.value.trim(),
                fromName: this.#fromName.value.trim(),
            },
        };
    }

    async #verify() {
        this.reset();
        try {
            await sendJson('/api/settings/gmail/verify', 'POST');
            get('gmail-status').hidden = false;
        } catch (error) {
            setError('gmail-error', error);
        }
    }

    #errors() {
        return this.#provider === 'smtp' ? this.#smtpErrors() : this.#gmailErrors();
    }

    #gmailErrors() {
        const user = this.#fields.gmailUser.value.trim();
        const password = this.#fields.gmailPassword.value.replaceAll(/\s/gu, '');
        const errors = {};
        if (!EMAIL_PATTERN.test(user)) errors.gmailUser = 'Enter the Gmail address you send from.';
        if (!password && !this.#saved.gmail) errors.gmailPassword = 'Enter the 16-character App Password.';
        else if (password && !/^[a-z0-9]{16}$/iu.test(password)) errors.gmailPassword = 'An App Password has 16 letters and numbers.';
        return errors;
    }

    #smtpErrors() {
        const f = this.#fields;
        const port = Number(f.smtpPort.value);
        const errors = {};
        if (!HOST_PATTERN.test(f.smtpHost.value.trim())) errors.smtpHost = 'Enter the SMTP server, like smtp.example.com.';
        if (!Number.isInteger(port) || port < 1 || port > 65_535) errors.smtpPort = 'Use a port from 1 to 65,535.';
        if (f.smtpUser.value.trim() && !f.smtpPassword.value && !this.#saved.smtp) errors.smtpPassword = 'Enter the SMTP password.';
        if (!EMAIL_PATTERN.test(f.smtpFrom.value.trim())) errors.smtpFrom = 'Enter the address emails are sent from.';
        return errors;
    }
}

export class SendingForm {
    #fields = { country: get('sending-country'), delay: get('sending-delay') };
    #feedback = formFeedback(this.#fields, 'sending-error');

    constructor(onSaved) {
        this.onSaved = onSaved;
        get('panel-sending').addEventListener('submit', event => this.#save(event));
    }

    fill({ countries, sending }) {
        this.#fillCountries(countries, sending.country);
        this.#fields.delay.value = String(sending.delaySeconds);
    }

    reset() {
        this.#feedback.clear();
    }

    #fillCountries(countries, selected) {
        const select = this.#fields.country;
        if (select.options.length !== countries.length) select.replaceChildren(...countryOptions(countries));
        select.value = selected;
    }

    #save(event) {
        event.preventDefault();
        this.reset();
        if (!this.#feedback.validate(this.#errors())) return;
        whileBusy(get('sending-save'), () => this.#send());
    }

    async #send() {
        try {
            const body = { country: this.#fields.country.value, delaySeconds: Number(this.#fields.delay.value) };
            this.onSaved(await sendJson('/api/settings/sending', 'PUT', body));
            toast('Sending settings saved');
        } catch (error) {
            this.#feedback.report(error);
        }
    }

    #errors() {
        const raw = this.#fields.delay.value;
        const seconds = Number(raw);
        const errors = {};
        if (!this.#fields.country.value) errors.country = 'Choose a country.';
        if (raw.trim() === '' || !Number.isFinite(seconds) || seconds < 0 || seconds > 3600) errors.delay = 'Use 0–3,600 seconds.';
        return errors;
    }
}

function countryOptions(countries) {
    return countries
        .map(code => [code, regionNames.of(code) ?? code])
        .sort((a, b) => a[1].localeCompare(b[1]))
        .map(([code, name]) => new Option(`${name} (${code})`, code));
}
