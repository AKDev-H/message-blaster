import { get, replayAnimation, sendJson, setError, toast } from '../shared/ui.mjs';

export class AiWriter {
    #prompt = get('ai-prompt');
    #trigger = get('ai-generate');
    #bar = get('ai-bar');

    constructor(editor, form) {
        this.editor = editor;
        this.form = form;
        this.#trigger.addEventListener('click', () => this.generate());
        this.#prompt.addEventListener('keydown', event => this.#onKey(event));
        editor.root.addEventListener('input', () => this.syncLabel());
    }

    setAvailable(available) {
        this.#bar.hidden = !available;
    }

    reset() {
        setError('ai-error', '');
        this.#prompt.value = '';
        this.syncLabel();
    }

    syncLabel() {
        this.#trigger.querySelector('.label').textContent = this.editor.value().text ? 'Rewrite' : 'Write';
    }

    async generate() {
        setError('ai-error', '');
        const channels = this.form.channels();
        if (!this.#canGenerate(channels) || this.#trigger.disabled) return;
        this.#setBusy(true);
        try {
            this.#apply(await this.#requestDraft(channels), channels);
        } catch (error) {
            setError('ai-error', error);
        } finally {
            this.#setBusy(false);
        }
    }

    #canGenerate(channels) {
        if (this.#prompt.value.trim().length < 3) return this.#askForPrompt();
        if (!channels.length) this.form.showError('channel', 'Choose at least one channel.');
        return channels.length > 0;
    }

    #askForPrompt() {
        setError('ai-error', 'Describe the message you want, e.g. “thank clients and share the new price list”.');
        this.#prompt.focus();
        return false;
    }

    #requestDraft(channels) {
        const body = { prompt: this.#prompt.value.trim(), channels, subject: this.form.subject.value, message: this.editor.value().text };
        return sendJson('/api/drafts/generate', 'POST', body);
    }

    #apply(draft, channels) {
        if (draft.subject && channels.includes('gmail')) this.form.subject.value = draft.subject;
        this.editor.setValue(draft.text, draft.html);
        for (const name of ['subject', 'script']) this.form.showError(name, '');
        replayAnimation(this.editor.root.closest('.editor'), 'generated');
        this.syncLabel();
        toast('Draft written. Review it before importing.');
    }

    #setBusy(busy) {
        this.#trigger.disabled = busy;
        this.#trigger.classList.toggle('busy', busy);
        if (busy) this.#bar.setAttribute('aria-busy', 'true');
        else this.#bar.removeAttribute('aria-busy');
    }

    #onKey(event) {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        this.generate();
    }
}
