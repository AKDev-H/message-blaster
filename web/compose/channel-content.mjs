export const SHARED = 'shared';
const CHANNELS = ['gmail', 'whatsapp'];
const FIELDS = ['message', 'subject', 'attachment'];

export class ChannelContent {
    #values = emptyValues();
    #tab = SHARED;
    #shown = null;

    constructor({ read, write }) {
        this.read = read;
        this.write = write;
    }

    get tab() {
        return this.#tab;
    }

    reset(initial) {
        this.#values = { ...emptyValues(), ...initial };
        this.#tab = SHARED;
        this.#display();
    }

    show(tab) {
        this.capture();
        this.#tab = tab;
        this.#display();
    }

    capture() {
        if (!this.#shown) return;
        const now = this.read();
        if (this.#tab === SHARED) {
            this.#values.shared = { text: now.text, html: now.html, subject: now.subject, attachment: now.attachment };
        } else {
            const own = this.#values[this.#tab];
            if (now.text !== this.#shown.text || now.html !== this.#shown.html) own.message = { text: now.text, html: now.html };
            if (now.subject !== this.#shown.subject) own.subject = now.subject;
            if (now.attachment !== this.#shown.attachment) own.attachment = now.attachment;
        }
        this.#shown = now;
    }

    effective(tab) {
        const shared = this.#values.shared;
        if (tab === SHARED) return shared;
        const own = this.#values[tab];
        return {
            text: own.message ? own.message.text : shared.text,
            html: own.message ? own.message.html : shared.html,
            subject: own.subject ?? shared.subject,
            attachment: own.attachment ?? shared.attachment,
        };
    }

    own(channel) {
        return this.#values[channel] ?? {};
    }

    overrides(tab) {
        if (!CHANNELS.includes(tab)) return [];
        const own = this.#values[tab];
        return FIELDS.filter(field => own[field] !== undefined);
    }

    resetChannel(channel) {
        if (!CHANNELS.includes(channel)) return;
        this.#values[channel] = {};
        if (this.#tab === channel) this.#display();
    }

    #display() {
        this.write(this.effective(this.#tab));
        this.#shown = this.read();
    }
}

function emptyValues() {
    return { shared: { text: '', html: '', subject: '', attachment: '' }, gmail: {}, whatsapp: {} };
}
