import { element, get, number } from '../shared/ui.mjs';
import { fileUrl, kindOf } from './files.mjs';
import { RENDERERS } from './renderers.mjs';

/** The dialog that previews an attachment. Opening another file cancels the previous preview. */
export class FileViewer {
    #dialog = get('viewer');
    #body = get('viewer-body');
    #current = 0;

    constructor() {
        this.#dialog.addEventListener('close', () => this.#clear());
    }

    async open(name, size) {
        const request = ++this.#current;
        this.#showHeader(name, size);
        this.#body.dataset.kind = kindOf(name);
        this.#body.replaceChildren(element('p', 'viewer-loading', 'Opening…'));
        if (!this.#dialog.open) this.#dialog.showModal();
        try {
            const content = await RENDERERS[kindOf(name)](name);
            if (request === this.#current) this.#body.replaceChildren(content);
        } catch (error) {
            if (request === this.#current) this.#showFailure(name, error);
        }
    }

    #showHeader(name, size) {
        get('viewer-title').textContent = name;
        get('viewer-meta').textContent = size === undefined ? '' : `${number.format(Math.ceil(size / 1024))} KB`;
        get('viewer-download').href = `${fileUrl(name)}?download`;
    }

    #showFailure(name, error) {
        const failure = RENDERERS.none(name);
        failure.querySelector('strong').textContent = error.message || 'The file could not be opened.';
        this.#body.replaceChildren(failure);
    }

    #clear() {
        this.#current++;
        this.#body.replaceChildren();
    }
}
