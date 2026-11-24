import { get, request, setError } from '../shared/ui.mjs';
import { GmailForm, SendingForm } from './forms.mjs';
import { TestSend } from './test-send.mjs';
import { WhatsAppPanel } from './whatsapp.mjs';

const POLL_MS = 2_000;

/**
 * The Settings dialog. Every change returns the full settings from the server,
 * which redraws the dialog. While a test is sending or WhatsApp is pairing, it polls.
 */
export class SettingsDialog {
    #dialog = get('settings');
    #tabs = [...this.#dialog.querySelectorAll('[role="tab"]')];
    #pollTimer = 0;

    constructor() {
        const redrawStatus = settings => this.render(settings, { forms: false });
        this.gmail = new GmailForm(settings => this.render(settings));
        this.sending = new SendingForm(settings => this.render(settings));
        this.whatsapp = new WhatsAppPanel(settings => this.render(settings));
        this.tests = { gmail: new TestSend(get('gmail-test'), 'gmail', redrawStatus), whatsapp: new TestSend(get('whatsapp-test'), 'whatsapp', redrawStatus) };
        this.#listen();
    }

    open(tab = 'gmail') {
        setError('settings-error', '');
        this.gmail.reset();
        this.sending.reset();
        for (const test of Object.values(this.tests)) test.reset();
        this.#selectTab(tab);
        this.#dialog.showModal();
        this.#refresh();
    }

    /** With `forms: false` only the status parts are redrawn, so half-typed form values are kept. */
    render(settings, { forms = true } = {}) {
        if (forms) this.#fillForms(settings);
        this.whatsapp.render(settings.whatsapp);
        const waiting = this.#renderTests(settings) || settings.whatsapp.status === 'pairing';
        window.clearTimeout(this.#pollTimer);
        if (waiting && this.#dialog.open) this.#pollTimer = window.setTimeout(() => this.#refresh({ forms: false }), POLL_MS);
    }

    #fillForms(settings) {
        this.gmail.fill(settings);
        this.sending.fill(settings);
    }

    /** The WhatsApp test only shows once a number is linked. Returns true while a test is sending. */
    #renderTests(settings) {
        const linked = settings.whatsapp.status === 'linked';
        get('whatsapp-test').hidden = !linked;
        const gmailSending = this.tests.gmail.render({ dryRun: settings.dryRun, test: settings.gmail.test, fallbackRecipient: settings.gmail.user });
        const whatsappSending = linked && this.tests.whatsapp.render({ dryRun: settings.dryRun, test: settings.whatsapp.test });
        return gmailSending || whatsappSending;
    }

    async #refresh(options) {
        try {
            this.render(await request('/api/settings'), options);
        } catch (error) {
            setError('settings-error', error);
        }
    }

    #listen() {
        for (const tab of this.#tabs) tab.addEventListener('click', () => this.#selectTab(tab.dataset.tab));
        get('settings-tabs').addEventListener('keydown', event => this.#onTabKey(event));
        this.#dialog.addEventListener('close', () => window.clearTimeout(this.#pollTimer));
    }

    #selectTab(name) {
        for (const tab of this.#tabs) {
            const selected = tab.dataset.tab === name;
            tab.setAttribute('aria-selected', String(selected));
            tab.tabIndex = selected ? 0 : -1;
            get(tab.getAttribute('aria-controls')).hidden = !selected;
        }
    }

    /** Left and right arrows move between tabs, wrapping around. */
    #onTabKey(event) {
        if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
        const index = this.#tabs.findIndex(tab => tab.getAttribute('aria-selected') === 'true');
        const next = this.#tabs[(index + (event.key === 'ArrowRight' ? 1 : this.#tabs.length - 1)) % this.#tabs.length];
        this.#selectTab(next.dataset.tab);
        next.focus();
    }
}
