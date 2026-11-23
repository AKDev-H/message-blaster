import { createEditor } from './editor.mjs';
import { button, campaignPath, element, formFeedback, get, number, request, setError, toast } from './ui.mjs';

const maxFileBytes = 10 * 1024 * 1024;
const namePattern = /^[a-z0-9][a-z0-9_-]{0,63}$/iu;
const channelLabels = { gmail: 'Gmail', whatsapp: 'WhatsApp' };
const scriptLimits = { gmail: 32767, whatsapp: 4096 };
const variableLabels = {
    client_name: 'Client name', client_id: 'Client ID', email_address: 'Email address',
    phone_number: 'Phone number', campaign_id: 'Campaign name', pdf_filename: 'Attachment name',
};
const variablesByChannel = {
    gmail: ['client_name', 'client_id', 'email_address', 'campaign_id', 'pdf_filename'],
    whatsapp: ['client_name', 'client_id', 'phone_number', 'campaign_id', 'pdf_filename'],
};

/** Fields usable in every selected channel, so a single script personalizes correctly everywhere. */
function sharedVariables(channels) {
    if (!channels.length) return [];
    return variablesByChannel[channels[0]].filter(token => channels.every(channel => variablesByChannel[channel].includes(token)));
}

/** Campaign names created for a send; two channels produce one suffixed campaign each. */
function campaignNames(name, channels) {
    return channels.length > 1 ? channels.map(channel => `${name}-${channel}`) : [name];
}

/** Checks an upload. Attachments may be any format; the server rejects blocked types such as programs. */
function fileError(file, extension, required) {
    if (!file) return required ? `Choose a ${extension ? 'workbook' : 'file'}.` : '';
    if (extension && !file.name.toLowerCase().endsWith(extension)) return `Choose a file ending in ${extension}.`;
    if (!file.size) return 'Choose a file that is not empty.';
    if (file.size > maxFileBytes) return 'Choose a file up to 10 MB.';
    return '';
}

function templateError(text, channels) {
    const allowed = sharedVariables(channels);
    for (const [, token] of text.matchAll(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}|\{\{|\}\}/gu)) {
        if (!token) return 'Close each field with }} — type {{ to pick one.';
        if (!allowed.includes(token)) {
            return channels.length > 1 ? `“${token}” isn’t available for both channels.` : `“${token}” isn’t available for ${channelLabels[channels[0]]}.`;
        }
    }
    return '';
}

function fileSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${number.format(Math.ceil(bytes / 1024))} KB`;
    return `${number.format(Math.round(bytes / 1024 ** 2 * 10) / 10)} MB`;
}

/** File-type label for the library list, e.g. PDF, DOCX, PNG. */
const fileKind = name => (name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toUpperCase().slice(0, 4) : 'FILE');

export function createComposer(onSaved, viewer) {
    const dialog = get('compose');
    const form = get('compose-form');
    const field = name => form.elements.namedItem(name);
    const channelInputs = [...form.querySelectorAll('input[name="channel"]')];
    const script = get('script-editor');
    const selectedChannels = () => channelInputs.filter(input => input.checked).map(input => input.value);
    const editor = createEditor(script, () => sharedVariables(selectedChannels())
        .map(token => ({ token, label: variableLabels[token] })));
    const controls = {
        id: field('id'), channel: channelInputs[0], workbook: field('workbook'),
        subject: field('subject'), script, attachment: field('attachment'),
    };
    const feedback = formFeedback(controls, 'compose-error');
    let editingId = '';
    let files = [];
    let attachmentRevision = 0;

    function validate() {
        const channels = selectedChannels();
        const name = controls.id.value.trim();
        const { text, html } = editor.value();
        const errors = {};
        if (!editingId) {
            if (!name) errors.id = 'Enter a campaign name.';
            else if (!namePattern.test(name)) errors.id = 'Use letters, numbers, hyphens, or underscores. Start with a letter or number.';
            else if (campaignNames(name, channels).some(id => id.length > 64)) errors.id = 'Use 55 characters or fewer when sending to both channels.';
        }
        if (!channels.length) {
            errors.channel = 'Choose at least one channel.';
            return { errors, text, html };
        }
        errors.workbook = fileError(controls.workbook.files[0], '.xlsx', !editingId);
        if (channels.includes('gmail')) {
            const subject = controls.subject.value;
            errors.subject = subject.length > 255 ? 'Use 255 characters or fewer.' : templateError(subject, ['gmail']);
        }
        const limit = Math.min(...channels.map(channel => scriptLimits[channel]));
        errors.script = text.length > limit ? `Use ${number.format(limit)} characters or fewer.` : templateError(text, channels);
        return { errors, text, html };
    }

    function renderAttachments(selection = controls.attachment.value) {
        const options = [new Option('No attachment', ''), ...files.map(file => new Option(`${file.name} · ${fileSize(file.size)}`, file.name))];
        if (selection && !files.some(file => file.name === selection)) options.push(new Option(selection, selection));
        controls.attachment.replaceChildren(...options);
        controls.attachment.value = selection;
        get('attachment-preview').disabled = !controls.attachment.value;

        const rows = files.map(file => {
            const node = element('li');
            const view = button('View', () => viewer.open(file.name, file.size), 'button ghost small', 'eye');
            view.setAttribute('aria-label', `View ${file.name}`);
            node.append(element('span', 'file-kind', fileKind(file.name)), element('strong', '', file.name),
                element('span', 'muted', fileSize(file.size)), view);
            return node;
        });
        get('library-files').replaceChildren(...(rows.length ? rows : [element('li', 'muted', 'No files uploaded yet.')]));
    }

    async function loadAttachments(errorId) {
        const revision = ++attachmentRevision;
        try {
            const result = await request('/api/attachments');
            if (revision !== attachmentRevision) return;
            files = result.files;
            renderAttachments();
        } catch (error) {
            if (revision === attachmentRevision) setError(errorId, error);
        }
    }

    async function uploadAttachment(input, errorId, selectUploaded) {
        const upload = input.files[0];
        if (!upload) return;
        const showError = message => selectUploaded ? feedback.show('attachment', message) : setError(errorId, message);
        const error = fileError(upload, '', true);
        showError(error);
        if (error) {
            input.value = '';
            return;
        }

        const data = new FormData();
        data.set('file', upload);
        const label = input.closest('.upload-button');
        input.disabled = true;
        label?.classList.add('busy');
        try {
            const { name } = await request('/api/attachments', { method: 'POST', body: data });
            attachmentRevision += 1;
            files = [...files.filter(file => file.name !== name), { name, size: upload.size }].sort((a, b) => a.name.localeCompare(b.name));
            renderAttachments(selectUploaded && dialog.open ? name : undefined);
            toast(`Uploaded ${name}`);
            await loadAttachments(errorId);
        } catch (failure) {
            showError(failure.message);
        } finally {
            input.value = '';
            input.disabled = false;
            label?.classList.remove('busy');
        }
    }

    function syncChannels() {
        const channels = selectedChannels();
        const both = channels.length > 1;
        get('template-download').href = `/api/template?channel=${both ? 'both' : channels[0] ?? 'gmail'}`;
        get('template-download').lastElementChild.textContent = both ? 'Download combined template' : 'Download Excel template';
        get('subject-field').hidden = !channels.includes('gmail');
        editor.setChannels(channels);
        syncNames();
    }

    function syncNames() {
        const channels = selectedChannels();
        const hint = get('channel-hint');
        const name = controls.id.value.trim() || 'name';
        hint.hidden = editingId !== '' || channels.length < 2;
        hint.textContent = `Creates ${campaignNames(name, channels).join(' and ')}.`;
    }

    function open(detail) {
        const campaign = detail?.campaign;
        const draft = detail?.draft;
        editingId = campaign?.id ?? '';
        const editing = Boolean(campaign);
        form.reset();
        get('compose-title').textContent = editing ? 'Edit campaign' : 'New campaign';
        get('compose-submit').textContent = editing ? 'Save and preview' : 'Import and preview';
        get('workbook-label').textContent = editing ? 'Replace workbook (optional)' : 'Choose an Excel workbook';
        controls.id.value = editingId;
        controls.id.readOnly = editing;
        for (const input of channelInputs) {
            input.checked = editing ? input.value === campaign.channel : input.value === 'gmail';
            input.disabled = editing;
        }
        controls.workbook.required = !editing;
        controls.subject.value = draft?.subject ?? '';
        renderAttachments(draft?.attachment ?? '');
        syncChannels();
        dialog.showModal();
        editor.setValue(draft?.script ?? '', draft?.scriptHtml);
        feedback.clear();
        setError('ai-error', '');
        get('ai-prompt').value = '';
        syncAiLabel();
        loadAttachments('compose-error');
    }

    async function save(event) {
        event.preventDefault();
        const submit = get('compose-submit');
        if (submit.disabled) return;
        setError('compose-error', '');
        const { errors, text, html } = validate();
        if (!feedback.validate(errors)) return;

        const data = new FormData(form);
        data.set('script', text);
        data.set('scriptHtml', html);
        data.set('id', controls.id.value.trim());
        if (!controls.workbook.files.length) data.delete('workbook');
        if (editingId) {
            data.delete('id');
            data.delete('channel');
        }

        submit.disabled = true;
        form.setAttribute('aria-busy', 'true');
        try {
            const result = await request(editingId ? `${campaignPath(editingId)}/draft` : '/api/campaigns', {
                method: editingId ? 'PUT' : 'POST',
                body: data,
            });
            dialog.close();
            const created = result.ids?.length ?? 1;
            toast(editingId ? 'Campaign updated' : created > 1 ? `Created ${created} campaigns` : 'Campaign created');
            await onSaved(result.id);
        } catch (error) {
            feedback.report(error);
        } finally {
            submit.disabled = false;
            form.removeAttribute('aria-busy');
        }
    }

    /** Asks the AI service to write (or rewrite) the fallback subject and message using the shared fields. */
    async function generate() {
        const prompt = get('ai-prompt');
        const trigger = get('ai-generate');
        const channels = selectedChannels();
        setError('ai-error', '');
        if (prompt.value.trim().length < 3) {
            setError('ai-error', 'Describe the message you want, e.g. “thank clients and share the new price list”.');
            prompt.focus();
            return;
        }
        if (!channels.length) {
            feedback.show('channel', 'Choose at least one channel.');
            return;
        }
        if (trigger.disabled) return;
        const { text } = editor.value();
        trigger.disabled = true;
        trigger.classList.add('busy');
        get('ai-bar').setAttribute('aria-busy', 'true');
        try {
            const draft = await request('/api/drafts/generate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: prompt.value.trim(), channels, subject: controls.subject.value, message: text }),
            });
            if (draft.subject && channels.includes('gmail')) controls.subject.value = draft.subject;
            editor.setValue(draft.text, draft.html);
            for (const name of ['subject', 'script']) feedback.show(name, '');
            const message = script.closest('.editor');
            message.classList.remove('generated');
            void message.offsetWidth;
            message.classList.add('generated');
            syncAiLabel();
            toast('Draft written. Review it before importing.');
        } catch (error) {
            setError('ai-error', error);
        } finally {
            trigger.disabled = false;
            trigger.classList.remove('busy');
            get('ai-bar').removeAttribute('aria-busy');
        }
    }

    function syncAiLabel() {
        get('ai-generate').querySelector('.label').textContent = editor.value().text ? 'Rewrite' : 'Write';
    }

    function revalidate(name, control) {
        if (control.hasAttribute('aria-invalid')) feedback.show(name, validate().errors[name]);
    }

    for (const [name, control] of Object.entries(controls)) {
        if (name === 'channel') continue;
        control.addEventListener(control.matches('select, input[type="file"]') ? 'change' : 'input', () => revalidate(name, control));
    }
    for (const input of channelInputs) {
        input.addEventListener('change', () => {
            syncChannels();
            for (const name of ['channel', 'id', 'subject', 'script']) revalidate(name, controls[name]);
        });
    }
    controls.id.addEventListener('input', syncNames);
    script.addEventListener('input', syncAiLabel);
    get('ai-generate').addEventListener('click', generate);
    get('ai-prompt').addEventListener('keydown', event => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        generate();
    });
    controls.workbook.addEventListener('change', () => {
        const upload = controls.workbook.files[0];
        get('workbook-label').textContent = upload?.name || (editingId ? 'Replace workbook (optional)' : 'Choose an Excel workbook');
        feedback.show('workbook', fileError(upload, '.xlsx', false));
    });
    controls.attachment.addEventListener('change', () => { get('attachment-preview').disabled = !controls.attachment.value; });
    get('attachment-preview').addEventListener('click', () => {
        const name = controls.attachment.value;
        if (name) viewer.open(name, files.find(file => file.name === name)?.size);
    });
    get('compose-upload').addEventListener('change', event => uploadAttachment(event.target, 'compose-error', true));
    get('library-upload').addEventListener('change', event => uploadAttachment(event.target, 'library-error', false));
    get('open-library').addEventListener('click', () => {
        setError('library-error', '');
        renderAttachments();
        get('library').showModal();
        loadAttachments('library-error');
    });
    form.addEventListener('submit', save);
    return {
        open,
        /** Shows AI writing only when the server has an API key configured. */
        setAiAvailable(available) {
            get('ai-bar').hidden = !available;
        },
    };
}
