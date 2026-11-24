import { ScriptEditor } from '../editor/editor.mjs';
import { campaignPath, formFeedback, get, request, setError, toast } from '../shared/ui.mjs';
import { AiWriter } from './ai-writer.mjs';
import { AttachmentPicker } from './attachments.mjs';
import { RecipientList } from './recipients/list.mjs';
import { draftErrors, fileError } from './validation.mjs';
import { campaignNames, variableOptions } from './variables.mjs';

export class Composer {
    #dialog = get('compose');
    #form = get('compose-form');
    #channelInputs = [...this.#form.querySelectorAll('input[name="channel"]')];
    #sourceInputs = [...this.#form.querySelectorAll('input[name="recipientSource"]')];
    #editingId = '';

    constructor(onSaved, viewer) {
        this.onSaved = onSaved;
        const script = get('script-editor');
        this.editor = new ScriptEditor(script, () => variableOptions(this.#channels()));
        this.controls = this.#findControls(script);
        this.feedback = formFeedback(this.controls, 'compose-error');
        this.recipients = new RecipientList(() => this.#channels(), message => this.feedback.show('recipients', message));
        this.attachments = new AttachmentPicker(this.controls.attachment, viewer, message => this.feedback.show('attachment', message));
        this.ai = new AiWriter(this.editor, { channels: () => this.#channels(), subject: this.controls.subject, showError: this.feedback.show });
        this.#listen();
    }

    open(detail) {
        this.#editingId = detail?.campaign?.id ?? '';
        this.#form.reset();
        this.#showMode(detail?.campaign);
        this.recipients.reset();
        this.#syncSource();
        this.#fillDraft(detail?.draft);
        this.#syncChannels();
        this.#dialog.showModal();
        this.editor.setValue(detail?.draft?.script ?? '', detail?.draft?.scriptHtml);
        this.feedback.clear();
        this.ai.reset();
        this.attachments.load('compose-error');
    }

    setAiAvailable(available) {
        this.ai.setAvailable(available);
    }

    #findControls(script) {
        const field = name => this.#form.elements.namedItem(name);
        return {
            id: field('id'), channel: this.#channelInputs[0], workbook: field('workbook'), recipients: get('recipient-table'),
            subject: field('subject'), script, attachment: field('attachment'),
        };
    }

    #channels() {
        return this.#channelInputs.filter(input => input.checked).map(input => input.value);
    }

    #typing() {
        return this.#sourceInputs.some(input => input.checked && input.value === 'typed');
    }

    #editing() {
        return this.#editingId !== '';
    }


    #showMode(campaign) {
        const editing = Boolean(campaign);
        get('compose-title').textContent = editing ? 'Edit campaign' : 'New campaign';
        get('compose-submit').textContent = editing ? 'Save and preview' : 'Import and preview';
        get('workbook-label').textContent = this.#workbookPrompt();
        this.controls.id.value = this.#editingId;
        this.controls.id.readOnly = editing;
        this.#chooseChannel(campaign?.channel);
    }

    #chooseChannel(channel) {
        for (const input of this.#channelInputs) {
            input.checked = channel ? input.value === channel : input.value === 'gmail';
            input.disabled = Boolean(channel);
        }
    }

    #fillDraft(draft) {
        this.controls.subject.value = draft?.subject ?? '';
        this.attachments.render(draft?.attachment ?? '');
    }

    #workbookPrompt() {
        return this.#editing() ? 'Replace workbook (optional)' : 'Choose an Excel workbook';
    }


    #syncChannels() {
        const channels = this.#channels();
        const both = channels.length > 1;
        get('template-download').href = `/api/template?channel=${both ? 'both' : channels[0] ?? 'gmail'}`;
        get('template-download').lastElementChild.textContent = both ? 'Download combined template' : 'Download Excel template';
        get('subject-field').hidden = !channels.includes('gmail');
        this.recipients.render();
        this.editor.setChannels(channels);
        this.#syncNames();
    }

    #syncSource() {
        const typed = this.#typing();
        get('source-excel').hidden = typed;
        get('source-typed').hidden = !typed;
        this.controls.workbook.required = !typed && !this.#editing();
        get('recipients-help').textContent = this.#editing() ? 'Leave empty to keep the current recipients.' : 'Tip: paste rows straight from a spreadsheet.';
        for (const name of ['workbook', 'recipients']) this.feedback.show(name, '');
    }

    #syncNames() {
        const channels = this.#channels();
        const hint = get('channel-hint');
        hint.hidden = this.#editing() || channels.length < 2;
        hint.textContent = `Creates ${campaignNames(this.controls.id.value.trim() || 'name', channels).join(' and ')}.`;
    }


    async #save(event) {
        event.preventDefault();
        const submit = get('compose-submit');
        if (submit.disabled) return;
        setError('compose-error', '');
        const { text, html } = this.editor.value();
        const errors = this.#errors(text);
        if (this.feedback.validate(errors)) await this.#submit(submit, this.#formData(text, html));
        else if (Object.keys(this.controls).find(name => errors[name]) === 'recipients') this.recipients.focusProblem(this.#editing());
    }

    #errors(text) {
        const draft = {
            channels: this.#channels(), editing: this.#editing(), name: this.controls.id.value.trim(), typing: this.#typing(),
            workbook: this.controls.workbook.files[0], subject: this.controls.subject.value, text,
        };
        return draftErrors(draft, () => this.recipients.error(this.#editing()));
    }

    #formData(text, html) {
        const data = new FormData(this.#form);
        data.set('script', text);
        data.set('scriptHtml', html);
        data.set('id', this.controls.id.value.trim());
        data.delete('recipientSource');
        this.#setRecipients(data);
        if (this.#editing()) ['id', 'channel'].forEach(name => data.delete(name));
        return data;
    }

    #setRecipients(data) {
        if (this.#typing()) this.#useTypedRecipients(data);
        else if (!this.controls.workbook.files.length) data.delete('workbook');
    }

    #useTypedRecipients(data) {
        data.delete('workbook');
        if (!this.recipients.hasEntries()) return;
        data.set('recipients', this.recipients.payload());
        data.set('recipientsConsent', 'yes');
    }

    async #submit(submit, data) {
        submit.disabled = true;
        this.#form.setAttribute('aria-busy', 'true');
        try {
            await this.#send(data);
        } catch (error) {
            this.feedback.report(error);
        } finally {
            submit.disabled = false;
            this.#form.removeAttribute('aria-busy');
        }
    }

    async #send(data) {
        const editing = this.#editing();
        const options = { method: editing ? 'PUT' : 'POST', body: data };
        const result = await request(editing ? `${campaignPath(this.#editingId)}/draft` : '/api/campaigns', options);
        this.#dialog.close();
        const created = result.ids?.length ?? 1;
        toast(editing ? 'Campaign updated' : created > 1 ? `Created ${created} campaigns` : 'Campaign created');
        await this.onSaved(result.id);
    }


    #listen() {
        for (const [name, control] of Object.entries(this.controls)) {
            if (name !== 'channel') control.addEventListener(control.matches('select, input[type="file"]') ? 'change' : 'input', () => this.#revalidate(name));
        }
        for (const input of this.#channelInputs) input.addEventListener('change', () => this.#onChannelChange());
        for (const input of this.#sourceInputs) input.addEventListener('change', () => this.#onSourceChange());
        this.controls.id.addEventListener('input', () => this.#syncNames());
        this.controls.workbook.addEventListener('change', () => this.#onWorkbookChosen());
        this.#form.addEventListener('submit', event => this.#save(event));
    }

    #revalidate(name) {
        if (this.controls[name].hasAttribute('aria-invalid')) this.feedback.show(name, this.#errors(this.editor.value().text)[name]);
    }

    #onChannelChange() {
        this.#syncChannels();
        for (const name of ['channel', 'id', 'subject', 'script']) this.#revalidate(name);
    }

    #onSourceChange() {
        this.#syncSource();
        if (this.#typing()) get('recipient-rows').querySelector('input')?.focus();
    }

    #onWorkbookChosen() {
        const upload = this.controls.workbook.files[0];
        get('workbook-label').textContent = upload?.name || this.#workbookPrompt();
        this.feedback.show('workbook', fileError(upload, '.xlsx', false));
    }
}
