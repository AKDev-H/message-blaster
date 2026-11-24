import { element } from '../shared/ui.mjs';

const TRIGGER = /\{\{\s*([a-z_]*)$/iu;

export class MentionMenu {
    #mention = null;

    constructor(editor, menu, variables) {
        this.editor = editor;
        this.root = editor.root;
        this.menu = menu;
        this.variables = variables;
        this.root.setAttribute('aria-haspopup', 'listbox');
        this.root.setAttribute('aria-controls', 'mention-menu');
        this.root.setAttribute('aria-expanded', 'false');
    }

    update() {
        const found = document.activeElement === this.root ? this.#findTrigger() : null;
        const items = found ? this.#matching(found.query) : [];
        if (!items.length) return this.close();
        const keepActive = this.#mention && this.#mention.query === found.query;
        const opening = !this.#mention;
        this.#mention = { ...found, items, active: keepActive ? Math.min(this.#mention.active, items.length - 1) : 0 };
        this.#show(opening);
    }

    close() {
        if (!this.#mention) return;
        this.#mention = null;
        this.menu.hidden = true;
        this.root.removeAttribute('aria-activedescendant');
        this.root.setAttribute('aria-expanded', 'false');
    }

    handleKey(event) {
        if (!this.#mention) return;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') this.#move(event.key === 'ArrowDown' ? 1 : -1);
        else if (event.key === 'Enter' || event.key === 'Tab') this.#choose(this.#mention.active);
        else if (event.key === 'Escape') this.close();
        else return;
        event.preventDefault();
        event.stopPropagation();
    }

    #matching(query) {
        return this.variables().filter(({ token, label }) => token.includes(query) || label.toLowerCase().includes(query));
    }

    #findTrigger() {
        const selection = window.getSelection();
        const range = this.editor.rangeInEditor(selection);
        if (!range || !selection.isCollapsed || range.startContainer.nodeType !== Node.TEXT_NODE) return null;
        const match = TRIGGER.exec(range.startContainer.data.slice(0, range.startOffset));
        if (!match) return null;
        const trigger = document.createRange();
        trigger.setStart(range.startContainer, match.index);
        trigger.setEnd(range.startContainer, range.startOffset);
        return { trigger, query: match[1].toLowerCase() };
    }

    #show(opening) {
        this.#render();
        this.menu.hidden = false;
        if (opening) this.root.setAttribute('aria-expanded', 'true');
        this.#position();
    }

    #render() {
        const { items, active } = this.#mention;
        this.menu.replaceChildren(...items.map((item, index) => this.#option(item, index === active, index)));
        this.root.setAttribute('aria-activedescendant', `mention-${items[active].token}`);
        this.menu.children[active]?.scrollIntoView({ block: 'nearest' });
    }

    #option(item, selected, index) {
        const option = element('li', 'mention-option');
        option.id = `mention-${item.token}`;
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', String(selected));
        option.append(element('span', '', item.label), element('code', '', `{{${item.token}}}`));
        option.addEventListener('mousedown', event => event.preventDefault());
        option.addEventListener('click', () => this.#choose(index));
        return option;
    }

    #position() {
        const caret = this.#mention.trigger.getBoundingClientRect();
        const box = this.root.closest('.editor').getBoundingClientRect();
        const left = Math.min(caret.left - box.left, box.width - this.menu.offsetWidth - 6);
        this.menu.style.left = `${Math.max(6, left)}px`;
        this.menu.style.top = `${caret.bottom - box.top + 4}px`;
    }

    #move(step) {
        const count = this.#mention.items.length;
        this.#mention.active = (this.#mention.active + step + count) % count;
        this.#render();
    }

    #choose(index) {
        if (!this.#mention) return;
        const { token } = this.#mention.items[index];
        const selection = window.getSelection();
        this.root.focus();
        selection.removeAllRanges();
        selection.addRange(this.#mention.trigger);
        this.close();
        this.editor.replaceSelection(`{{${token}}}`);
        this.editor.notifyChange();
    }
}
