import { formFeedback, get, sendJson, setError, toast, whileBusy } from '../shared/ui.mjs';

const regionNames = new Intl.DisplayNames(undefined, { type: 'region' });

/** The Gmail tab: address, App Password, and a button to test the sign-in. `onSaved(settings)` redraws the dialog. */
export class GmailForm {
    #fields = { gmailUser: get('gmail-user'), gmailPassword: get('gmail-password') };
    #feedback = formFeedback(this.#fields, 'gmail-error');
    #passwordSet = false;

    constructor(onSaved) {
        this.onSaved = onSaved;
        get('panel-gmail').addEventListener('submit', event => this.#save(event));
        get('gmail-verify').addEventListener('click', event => whileBusy(event.currentTarget, () => this.#verify()));
    }

    /** The saved password is never sent back; the field stays empty and says it is saved. */
    fill({ gmail }) {
        this.#passwordSet = gmail.passwordSet;
        this.#fields.gmailUser.value = gmail.user;
        this.#fields.gmailPassword.value = '';
        this.#fields.gmailPassword.placeholder = gmail.passwordSet ? 'Saved. Leave blank to keep it.' : '16-character App Password';
        get('gmail-password-help').textContent = gmail.passwordUnreadable
            ? 'The saved App Password can’t be read on this computer. Enter it again.'
            : 'Requires 2-Step Verification on the Google account. Saved encrypted.';
        get('gmail-verify').disabled = !gmail.user || !gmail.passwordSet;
    }

    reset() {
        this.#feedback.clear();
        get('gmail-status').hidden = true;
    }

    #save(event) {
        event.preventDefault();
        this.reset();
        if (!this.#feedback.validate(this.#errors())) return;
        whileBusy(get('gmail-save'), () => this.#send());
    }

    async #send() {
        try {
            const body = { user: this.#fields.gmailUser.value.trim(), password: this.#fields.gmailPassword.value };
            this.onSaved(await sendJson('/api/settings/gmail', 'PUT', body));
            toast('Gmail settings saved');
        } catch (error) {
            this.#feedback.report(error);
        }
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

    /** The password may be left empty when one is already saved. */
    #errors() {
        const user = this.#fields.gmailUser.value.trim();
        const password = this.#fields.gmailPassword.value.replaceAll(/\s/gu, '');
        const errors = {};
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(user)) errors.gmailUser = 'Enter the Gmail address you send from.';
        if (!password && !this.#passwordSet) errors.gmailPassword = 'Enter the 16-character App Password.';
        else if (password && !/^[a-z0-9]{16}$/iu.test(password)) errors.gmailPassword = 'An App Password has 16 letters and numbers.';
        return errors;
    }
}

/** The Sending tab: default country for phone numbers, and the delay between messages. */
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

    /** Countries are listed by their name in the user's language. The list is only built once. */
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
