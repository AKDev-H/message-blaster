import { get, number } from '../shared/ui.mjs';
import { MentionMenu } from './mentions.mjs';
import { renderRichText, textWithBreaks } from './rich-text.mjs';

const LIST_FORMATS = new Set(['insertUnorderedList', 'insertOrderedList']);

/**
 * The message editor: a contenteditable box with a formatting toolbar,
 * a word count, and the "{{" placeholder menu. Pasted content is always plain text.
 */
export class ScriptEditor {
    #toolbar = get('script-toolbar');
    #controls = [...this.#toolbar.querySelectorAll('[data-format]')];
    #count = get('script-count');
    #savedRange = null;

    constructor(root, variables) {
        this.root = root;
        this.mentions = new MentionMenu(this, get('mention-menu'), variables);
        this.#listenToToolbar();
        this.#listenToEditor();
    }

    /** WhatsApp has no bold or italics here, only lists. */
    setChannels(channels) {
        const whatsappOnly = channels.length === 1 && channels[0] === 'whatsapp';
        for (const control of this.#controls) {
            control.hidden = whatsappOnly && !LIST_FORMATS.has(control.dataset.format);
            control.disabled = !document.queryCommandSupported(control.dataset.format);
        }
    }

    setValue(text, html) {
        this.#savedRange = null;
        this.mentions.close();
        if (html) renderRichText(this.root, html);
        else this.root.replaceChildren(textWithBreaks(text));
        this.#updateCount();
    }

    /** The message as plain text and as cleaned HTML. Both are empty when there is no text. */
    value() {
        const text = this.root.innerText.trim();
        if (!text) return { text: '', html: '' };
        const clean = document.createElement('div');
        renderRichText(clean, this.root.innerHTML);
        return { text, html: clean.innerHTML };
    }

    rangeInEditor(selection = window.getSelection()) {
        if (!selection?.rangeCount) return null;
        const range = selection.getRangeAt(0);
        return this.root.contains(range.commonAncestorContainer) ? range : null;
    }

    /** Types the text at the caret, falling back to inserting nodes where execCommand is unavailable. */
    replaceSelection(value) {
        if (document.execCommand('insertText', false, value)) return;
        const selection = window.getSelection();
        const range = this.rangeInEditor(selection);
        if (!range) return;
        const fragment = textWithBreaks(value);
        const last = fragment.lastChild;
        range.deleteContents();
        range.insertNode(fragment);
        placeCaretAfter(selection, range, last);
    }

    notifyChange() {
        this.#rememberSelection();
        this.root.dispatchEvent(new Event('input', { bubbles: true }));
    }

    #listenToToolbar() {
        this.#toolbar.addEventListener('mousedown', event => {
            if (event.target.closest('[data-format]')) event.preventDefault();
        });
        this.#toolbar.addEventListener('click', event => this.#applyFormat(event.target.closest('[data-format]')));
    }

    #listenToEditor() {
        this.root.addEventListener('keydown', event => this.mentions.handleKey(event));
        this.root.addEventListener('input', () => this.#onInput());
        this.root.addEventListener('blur', () => this.mentions.close());
        this.root.addEventListener('paste', event => this.#pastePlainText(event));
        this.root.addEventListener('drop', event => event.preventDefault());
        document.addEventListener('selectionchange', () => this.#onSelectionChange());
    }

    #applyFormat(control) {
        if (!control || control.disabled) return;
        this.#focus();
        document.execCommand(control.dataset.format);
        this.notifyChange();
    }

    #onInput() {
        this.#updateCount();
        this.mentions.update();
    }

    #onSelectionChange() {
        if (document.activeElement !== this.root) return;
        this.#rememberSelection();
        this.mentions.update();
    }

    #pastePlainText(event) {
        event.preventDefault();
        const text = event.clipboardData?.getData('text/plain');
        if (!text) return;
        this.#focus();
        this.replaceSelection(text);
        this.notifyChange();
    }

    /** Remembers the caret so toolbar clicks apply where the user was, and shows which formats are on. */
    #rememberSelection() {
        const range = this.rangeInEditor();
        if (!range) return;
        this.#savedRange = range.cloneRange();
        for (const control of this.#controls) control.setAttribute('aria-pressed', String(document.queryCommandState(control.dataset.format)));
    }

    #focus() {
        const selection = window.getSelection();
        if (document.activeElement === this.root && this.rangeInEditor(selection)) return;
        this.root.focus();
        if (this.#savedRange && this.root.contains(this.#savedRange.commonAncestorContainer)) restoreRange(selection, this.#savedRange);
        else caretAtEnd(selection, this.root);
    }

    #updateCount() {
        const text = this.root.innerText.trim();
        this.root.dataset.empty = String(text.length === 0);
        const words = text ? text.split(/\s+/u).length : 0;
        this.#count.textContent = `${number.format(words)} ${words === 1 ? 'word' : 'words'} · ${number.format(text.length)} characters`;
    }
}

function restoreRange(selection, range) {
    selection.removeAllRanges();
    selection.addRange(range);
}

function caretAtEnd(selection, root) {
    selection.selectAllChildren(root);
    selection.collapseToEnd();
}

function placeCaretAfter(selection, range, node) {
    range.setStartAfter(node);
    range.collapse(true);
    restoreRange(selection, range);
}
