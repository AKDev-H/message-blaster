import { ScriptEditor } from '../editor/editor.mjs';
import { CHANNEL_LABELS } from '../shared/labels.mjs';
import { formFeedback, get, groupPath, request, setError, toast } from '../shared/ui.mjs';
import { AiWriter } from './ai-writer.mjs';
import { AttachmentPicker } from './attachments.mjs';
import { ChannelContent, SHARED } from './channel-content.mjs';
import { RecipientList } from './recipients/list.mjs';
import { draftErrors, fileError } from './validation.mjs';
import { variableOptions } from './variables.mjs';

export class Composer {
    #dialog = get('compose');
    #form = get('compose-form');
    #channelInputs = [...this.#form.querySelectorAll('input[name="channel"]')];
    #sourceInputs = [...this.#form.querySelectorAll('input[name="recipientSource"]')];
    #tabs = [...get('content-tabs').querySelectorAll('[data-content-tab]')];
    #editingSlug = '';
    #locked = [];

    constructor(onSaved, viewer) {
        this.onSaved = onSaved;
        const script = get('script-editor');
        this.editor = new ScriptEditor(script, () => variableOptions(this.#tabChannels()));
        this.controls = this.#findControls(script);
        this.feedback = formFeedback(this.controls, 'compose-error');
        this.recipients = new RecipientList(() => this.#channels(), message => this.feedback.show('recipients', message));
        this.attachments = new AttachmentPicker(this.controls.attachment, viewer, message => this.feedback.show('attachment', message));
        this.ai = new AiWriter(this.editor, { channels: () => this.#tabChannels(), subject: this.controls.subject, showError: this.feedback.show });
        this.content = new ChannelContent({
            read: () => ({ ...this.editor.value(), subject: this.controls.subject.value, attachment: this.controls.attachment.value }),
            write: value => this.#writeContent(value),
        });
        this.#listen();
    }

    open(detail) {
        const campaign = detail?.campaign;
        this.#editingSlug = campaign?.slug ?? '';
        this.#locked = detail ? detail.channels.filter(channel => !channel.draft).map(channel => channel.channel) : [];
        this.#form.reset();
        this.#showMode(campaign);
        this.recipients.reset();
        this.#syncSource();
        this.#dialog.showModal();
        this.content.reset(initialContent(detail));
        this.#syncChannels();
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

    #combined() {
        return this.#channels().length > 1;
    }

    #tabChannels() {
        const tab = this.content.tab;
        return tab === SHARED ? this.#channels() : [tab];
    }

    #typing() {
        return this.#sourceInputs.some(input => input.checked && input.value === 'typed');
    }

    #editing() {
        return this.#editingSlug !== '';
    }

    #showMode(campaign) {
        const editing = Boolean(campaign);
        get('compose-title').textContent = editing ? 'Edit campaign' : 'New campaign';
        get('compose-submit').textContent = editing ? 'Save and preview' : 'Import and preview';
        get('workbook-label').textContent = this.#workbookPrompt();
        this.controls.id.value = this.#editingSlug;
        this.controls.id.readOnly = editing;
        for (const input of this.#channelInputs) {
            input.checked = campaign ? campaign.channels.includes(input.value) : input.value === 'gmail';
            input.disabled = editing;
        }
    }

    #workbookPrompt() {
        return this.#editing() ? 'Replace workbook (optional)' : 'Choose an Excel workbook';
    }

    #syncChannels() {
        const channels = this.#channels();
        const both = channels.length > 1;
        get('template-download').href = `/api/template?channel=${both ? 'both' : channels[0] ?? 'gmail'}`;
        get('template-download').lastElementChild.textContent = both ? 'Download combined template' : 'Download Excel template';
        get('content-tabs').hidden = !both;
        if (!both && this.content.tab !== SHARED) this.content.show(SHARED);
        for (const tab of this.#tabs) {
            const channel = tab.dataset.contentTab;
            tab.hidden = channel !== SHARED && !channels.includes(channel);
            tab.disabled = this.#locked.includes(channel);
            tab.title = tab.disabled ? `${CHANNEL_LABELS[channel]} has started sending, so its message can’t change.` : '';
        }
        this.recipients.render();
        this.#syncTab();
        this.#syncNames();
    }

    #syncTab() {
        const tab = this.content.tab;
        const channels = this.#tabChannels();
        for (const node of this.#tabs) {
            const selected = node.dataset.contentTab === tab;
            node.setAttribute('aria-selected', String(selected));
            node.tabIndex = selected ? 0 : -1;
            node.querySelector('.override-dot')?.toggleAttribute('hidden', !this.content.overrides(node.dataset.contentTab).length);
        }
        get('subject-field').hidden = !channels.includes('gmail');
        this.editor.setChannels(channels);
        const label = tab === SHARED ? '' : ` for ${CHANNEL_LABELS[tab]}`;
        get('script-title').textContent = `${tab === SHARED && this.#combined() ? 'Shared message' : 'Fallback message'}${label}`;
        document.querySelector('label[for="campaign-subject"]').textContent = `Fallback subject${label}`;
        document.querySelector('label[for="campaign-attachment"]').textContent = `Attachment${label}`;
        this.#showInheritance(tab);
    }

    #showInheritance(tab) {
        const status = get('content-status');
        status.hidden = tab === SHARED;
        if (tab === SHARED) return;
        const fields = tab === 'gmail' ? ['message', 'subject', 'attachment'] : ['message', 'attachment'];
        const overridden = this.content.overrides(tab);
        const inherited = fields.filter(field => !overridden.includes(field));
        const parts = [];
        if (overridden.length) parts.push(`Customized: ${overridden.join(', ')}`);
        if (inherited.length) parts.push(`Inherits shared ${inherited.join(', ')}`);
        get('content-inherits').textContent = `${parts.join(' · ')}.`;
        get('content-reset').hidden = !overridden.length;
    }

    #writeContent({ text, html, subject, attachment }) {
        this.editor.setValue(text ?? '', html);
        this.controls.subject.value = subject ?? '';
        this.attachments.render(attachment ?? '');
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
        const hint = get('channel-hint');
        hint.hidden = this.#editing() || !this.#combined();
        hint.textContent = 'One campaign for both channels. Write the shared message, then customize Gmail or WhatsApp if needed.';
    }

    async #save(event) {
        event.preventDefault();
        const submit = get('compose-submit');
        if (submit.disabled) return;
        setError('compose-error', '');
        this.content.capture();
        const problem = this.#firstProblem();
        if (problem) return this.#showProblem(problem);
        await this.#submit(submit, this.#formData());
    }

    #firstProblem() {
        const tabs = [SHARED, ...(this.#combined() ? this.#channels().filter(channel => !this.#locked.includes(channel)) : [])];
        for (const tab of tabs) {
            const errors = this.#errors(tab);
            if (Object.values(errors).some(Boolean)) return { tab, errors };
        }
        return null;
    }

    #showProblem({ tab, errors }) {
        if (tab !== this.content.tab) {
            this.content.show(tab);
            this.#syncTab();
        }
        if (!this.feedback.validate(errors) && Object.keys(this.controls).find(name => errors[name]) === 'recipients') {
            this.recipients.focusProblem(this.#editing());
        }
    }

    #errors(tab = this.content.tab) {
        const value = this.content.effective(tab);
        const shared = tab === SHARED;
        const draft = {
            channels: shared ? this.#channels() : [tab], editing: this.#editing() || !shared, name: this.controls.id.value.trim(), typing: this.#typing(),
            workbook: this.controls.workbook.files[0], subject: value.subject ?? '', text: value.text ?? '',
        };
        const errors = draftErrors(draft, () => this.recipients.error(this.#editing()));
        if (!shared) {
            delete errors.workbook;
            delete errors.recipients;
        }
        return errors;
    }

    #formData() {
        const data = new FormData(this.#form);
        const shared = this.content.effective(SHARED);
        data.set('script', shared.text ?? '');
        data.set('scriptHtml', shared.html ?? '');
        data.set('subject', shared.subject ?? '');
        data.set('attachment', shared.attachment ?? '');
        data.set('id', this.controls.id.value.trim());
        data.delete('recipientSource');
        if (this.#combined()) this.#setOverrides(data);
        this.#setRecipients(data);
        if (this.#editing()) ['id', 'channel'].forEach(name => data.delete(name));
        return data;
    }

    #setOverrides(data) {
        for (const channel of this.#channels()) {
            const own = this.content.own(channel);
            if (own.message) {
                data.set(`${channel}.script`, own.message.text ?? '');
                data.set(`${channel}.scriptHtml`, own.message.html ?? '');
            }
            if (channel === 'gmail' && own.subject !== undefined) data.set('gmail.subject', own.subject);
            if (own.attachment !== undefined) data.set(`${channel}.attachment`, own.attachment);
        }
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
        const result = await request(editing ? `${groupPath(this.#editingSlug)}/draft` : '/api/campaign-groups', options);
        this.#dialog.close();
        toast(editing ? 'Campaign updated' : 'Campaign created');
        await this.onSaved(result.slug);
    }

    #listen() {
        for (const [name, control] of Object.entries(this.controls)) {
            if (name !== 'channel') control.addEventListener(control.matches('select, input[type="file"]') ? 'change' : 'input', () => this.#revalidate(name));
        }
        for (const input of this.#channelInputs) input.addEventListener('change', () => this.#onChannelChange());
        for (const input of this.#sourceInputs) input.addEventListener('change', () => this.#onSourceChange());
        for (const tab of this.#tabs) tab.addEventListener('click', () => this.#switchTab(tab.dataset.contentTab));
        get('content-tabs').addEventListener('keydown', event => this.#moveTab(event));
        get('content-reset').addEventListener('click', () => this.#resetTab());
        this.controls.id.addEventListener('input', () => this.#syncNames());
        this.controls.workbook.addEventListener('change', () => this.#onWorkbookChosen());
        this.#form.addEventListener('submit', event => this.#save(event));
    }

    #switchTab(tab) {
        if (tab === this.content.tab) return;
        this.feedback.clear();
        this.content.show(tab);
        this.#syncTab();
    }

    #moveTab(event) {
        if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
        const tabs = this.#tabs.filter(tab => !tab.hidden && !tab.disabled);
        const index = tabs.findIndex(tab => tab.dataset.contentTab === this.content.tab);
        const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
        this.#switchTab(next.dataset.contentTab);
        next.focus();
    }

    #resetTab() {
        this.content.resetChannel(this.content.tab);
        this.#syncTab();
        this.feedback.clear();
    }

    #revalidate(name) {
        if (this.content.tab !== SHARED && ['script', 'subject', 'attachment'].includes(name)) this.#showInheritance(this.content.tab);
        if (this.controls[name].hasAttribute('aria-invalid')) {
            this.content.capture();
            this.feedback.show(name, this.#errors()[name]);
        }
    }

    #onChannelChange() {
        this.content.capture();
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

function initialContent(detail) {
    const shared = detail?.draft?.shared;
    const content = { shared: { text: shared?.script ?? '', html: shared?.scriptHtml, subject: shared?.subject ?? '', attachment: shared?.attachment ?? '' } };
    for (const channel of detail?.channels ?? []) {
        const draft = channel.draft;
        if (!draft?.overrides?.length || detail.channels.length < 2) continue;
        const own = {};
        if (draft.overrides.includes('message')) own.message = { text: draft.script, html: draft.scriptHtml };
        if (draft.overrides.includes('subject')) own.subject = draft.subject;
        if (draft.overrides.includes('attachment')) own.attachment = draft.attachment;
        content[channel.channel] = own;
    }
    return content;
}
