import { fileKind, fileSize } from '../shared/labels.mjs';
import { button, element, get, request, setError, toast } from '../shared/ui.mjs';
import { fileError } from './validation.mjs';

export class AttachmentPicker {
    #files = [];
    #revision = 0;

    constructor(select, viewer, showFieldError) {
        this.select = select;
        this.viewer = viewer;
        this.showFieldError = showFieldError;
        this.#listen();
    }

    render(selection = this.select.value) {
        const options = [new Option('No attachment', ''), ...this.#files.map(file => new Option(`${file.name} · ${fileSize(file.size)}`, file.name))];
        if (selection && !this.#files.some(file => file.name === selection)) options.push(new Option(selection, selection));
        this.select.replaceChildren(...options);
        this.select.value = selection;
        this.#syncPreviewButton();
        get('library-files').replaceChildren(...this.#libraryRows());
    }

    async load(errorId) {
        const revision = ++this.#revision;
        try {
            const { files } = await request('/api/attachments');
            if (revision !== this.#revision) return;
            this.#files = files;
            this.render();
        } catch (error) {
            if (revision === this.#revision) setError(errorId, error);
        }
    }

    #listen() {
        this.select.addEventListener('change', () => this.#syncPreviewButton());
        get('attachment-preview').addEventListener('click', () => this.#previewSelected());
        get('compose-upload').addEventListener('change', event => this.#upload(event.target, 'compose-error', true));
        get('library-upload').addEventListener('change', event => this.#upload(event.target, 'library-error', false));
        get('open-library').addEventListener('click', () => this.#openLibrary());
    }

    #syncPreviewButton() {
        get('attachment-preview').disabled = !this.select.value;
    }

    #previewSelected() {
        const name = this.select.value;
        if (name) this.viewer.open(name, this.#files.find(file => file.name === name)?.size);
    }

    #openLibrary() {
        setError('library-error', '');
        this.render();
        get('library').showModal();
        this.load('library-error');
    }

    #libraryRows() {
        if (!this.#files.length) return [element('li', 'muted', 'No files uploaded yet.')];
        return this.#files.map(file => this.#libraryRow(file));
    }

    #libraryRow(file) {
        const view = button('View', () => this.viewer.open(file.name, file.size), 'button ghost small', 'eye');
        view.setAttribute('aria-label', `View ${file.name}`);
        const row = element('li');
        row.append(element('span', 'file-kind', fileKind(file.name)), element('strong', '', file.name), element('span', 'muted', fileSize(file.size)), view);
        return row;
    }

    async #upload(input, errorId, selectUploaded) {
        const upload = input.files[0];
        if (!upload) return;
        const showError = message => (selectUploaded ? this.showFieldError(message) : setError(errorId, message));
        const problem = fileError(upload, '', true);
        showError(problem);
        if (problem) input.value = '';
        else await this.#send(input, upload, { errorId, selectUploaded, showError });
    }

    async #send(input, upload, { errorId, selectUploaded, showError }) {
        const label = input.closest('.upload-button');
        input.disabled = true;
        label?.classList.add('busy');
        try {
            await this.#store(upload, errorId, selectUploaded);
        } catch (failure) {
            showError(failure.message);
        } finally {
            input.value = '';
            input.disabled = false;
            label?.classList.remove('busy');
        }
    }

    async #store(upload, errorId, selectUploaded) {
        const data = new FormData();
        data.set('file', upload);
        const { name } = await request('/api/attachments', { method: 'POST', body: data });
        this.#revision += 1;
        this.#files = [...this.#files.filter(file => file.name !== name), { name, size: upload.size }].sort((a, b) => a.name.localeCompare(b.name));
        this.render(selectUploaded && get('compose').open ? name : undefined);
        toast(`Uploaded ${name}`);
        await this.load(errorId);
    }
}
