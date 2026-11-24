import { element, get, number } from './ui.mjs';

const formattingTags = new Set(['p', 'div', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'del', 'ul', 'ol', 'li', 'blockquote']);
const discardedTags = new Set(['script', 'style', 'template', 'svg', 'math', 'iframe', 'object']);
const listFormats = new Set(['insertUnorderedList', 'insertOrderedList']);
const mentionTrigger = /\{\{\s*([a-z_]*)$/iu;

function appendSafeNodes(source, target) {
    for (const child of source.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
            target.append(document.createTextNode(child.data));
        } else if (child.nodeType === Node.ELEMENT_NODE && !discardedTags.has(child.localName)) {
            if (formattingTags.has(child.localName)) {
                const node = document.createElement(child.localName);
                appendSafeNodes(child, node);
                target.append(node);
            } else {
                appendSafeNodes(child, target);
            }
        }
    }
}

export function renderRichText(target, html) {
    const template = document.createElement('template');
    template.innerHTML = html;
    const fragment = document.createDocumentFragment();
    appendSafeNodes(template.content, fragment);
    target.replaceChildren(fragment);
}

export function createEditor(root, variables) {
    const toolbar = get('script-toolbar');
    const controls = [...toolbar.querySelectorAll('[data-format]')];
    const count = get('script-count');
    const menu = get('mention-menu');
    const frame = root.closest('.editor');
    let savedRange = null;
    let mention = null;

    function rangeInEditor(selection = window.getSelection()) {
        if (!selection?.rangeCount) return null;
        const range = selection.getRangeAt(0);
        return root.contains(range.commonAncestorContainer) ? range : null;
    }

    function rememberSelection() {
        const range = rangeInEditor();
        if (!range) return;
        savedRange = range.cloneRange();
        for (const control of controls) {
            control.setAttribute('aria-pressed', String(document.queryCommandState(control.dataset.format)));
        }
    }

    function focusEditor() {
        const selection = window.getSelection();
        if (document.activeElement === root && rangeInEditor(selection)) return;
        root.focus();
        if (savedRange && root.contains(savedRange.commonAncestorContainer)) {
            selection.removeAllRanges();
            selection.addRange(savedRange);
        } else {
            selection.selectAllChildren(root);
            selection.collapseToEnd();
        }
    }

    function updateCount() {
        const text = root.innerText.trim();
        root.dataset.empty = String(text.length === 0);
        const words = text ? text.split(/\s+/u).length : 0;
        count.textContent = `${number.format(words)} ${words === 1 ? 'word' : 'words'} · ${number.format(text.length)} characters`;
    }

    function notifyChange() {
        rememberSelection();
        root.dispatchEvent(new Event('input', { bubbles: true }));
    }

    function replaceSelection(value) {
        if (document.execCommand('insertText', false, value)) return;
        const selection = window.getSelection();
        const range = rangeInEditor(selection);
        if (!range) return;
        const fragment = document.createDocumentFragment();
        value.split(/\r?\n/u).forEach((line, index) => {
            if (index > 0) fragment.append(document.createElement('br'));
            fragment.append(document.createTextNode(line));
        });
        const last = fragment.lastChild;
        range.deleteContents();
        range.insertNode(fragment);
        range.setStartAfter(last);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
    }

    function insertText(value) {
        if (!value) return;
        focusEditor();
        replaceSelection(value);
        notifyChange();
    }


    function closeMention() {
        if (!mention) return;
        mention = null;
        menu.hidden = true;
        root.removeAttribute('aria-activedescendant');
        root.setAttribute('aria-expanded', 'false');
    }

    function findTrigger() {
        const selection = window.getSelection();
        const range = rangeInEditor(selection);
        if (!range || !selection.isCollapsed || range.startContainer.nodeType !== Node.TEXT_NODE) return null;
        const match = mentionTrigger.exec(range.startContainer.data.slice(0, range.startOffset));
        if (!match) return null;
        const trigger = document.createRange();
        trigger.setStart(range.startContainer, match.index);
        trigger.setEnd(range.startContainer, range.startOffset);
        return { trigger, query: match[1].toLowerCase() };
    }

    function renderMention() {
        menu.replaceChildren(...mention.items.map((item, index) => {
            const option = element('li', 'mention-option');
            option.id = `mention-${item.token}`;
            option.setAttribute('role', 'option');
            option.setAttribute('aria-selected', String(index === mention.active));
            option.append(element('span', '', item.label), element('code', '', `{{${item.token}}}`));
            option.addEventListener('mousedown', event => event.preventDefault());
            option.addEventListener('click', () => chooseMention(index));
            return option;
        }));
        const active = mention.items[mention.active];
        root.setAttribute('aria-activedescendant', `mention-${active.token}`);
        menu.children[mention.active]?.scrollIntoView({ block: 'nearest' });
    }

    function positionMention() {
        const caret = mention.trigger.getBoundingClientRect();
        const box = frame.getBoundingClientRect();
        const left = Math.min(caret.left - box.left, box.width - menu.offsetWidth - 6);
        menu.style.left = `${Math.max(6, left)}px`;
        menu.style.top = `${caret.bottom - box.top + 4}px`;
    }

    function updateMention() {
        const found = document.activeElement === root ? findTrigger() : null;
        const items = found
            ? variables().filter(({ token, label }) => token.includes(found.query) || label.toLowerCase().includes(found.query))
            : [];
        if (!items.length) return closeMention();
        const active = mention && mention.query === found.query ? Math.min(mention.active, items.length - 1) : 0;
        const opening = !mention;
        mention = { ...found, items, active };
        renderMention();
        menu.hidden = false;
        if (opening) root.setAttribute('aria-expanded', 'true');
        positionMention();
    }

    function chooseMention(index) {
        if (!mention) return;
        const { token } = mention.items[index];
        const selection = window.getSelection();
        root.focus();
        selection.removeAllRanges();
        selection.addRange(mention.trigger);
        closeMention();
        replaceSelection(`{{${token}}}`);
        notifyChange();
    }

    function onMentionKey(event) {
        if (!mention) return;
        const last = mention.items.length - 1;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            const step = event.key === 'ArrowDown' ? 1 : -1;
            mention.active = (mention.active + step + last + 1) % (last + 1);
            renderMention();
        } else if (event.key === 'Enter' || event.key === 'Tab') {
            chooseMention(mention.active);
        } else if (event.key === 'Escape') {
            closeMention();
        } else {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
    }


    toolbar.addEventListener('mousedown', event => {
        if (event.target.closest('[data-format]')) event.preventDefault();
    });
    toolbar.addEventListener('click', event => {
        const control = event.target.closest('[data-format]');
        if (!control || control.disabled) return;
        focusEditor();
        document.execCommand(control.dataset.format);
        notifyChange();
    });
    root.setAttribute('aria-haspopup', 'listbox');
    root.setAttribute('aria-controls', 'mention-menu');
    root.setAttribute('aria-expanded', 'false');
    root.addEventListener('keydown', onMentionKey);
    root.addEventListener('input', () => {
        updateCount();
        updateMention();
    });
    root.addEventListener('blur', closeMention);
    root.addEventListener('paste', event => {
        event.preventDefault();
        insertText(event.clipboardData?.getData('text/plain'));
    });
    root.addEventListener('drop', event => event.preventDefault());
    document.addEventListener('selectionchange', () => {
        if (document.activeElement !== root) return;
        rememberSelection();
        updateMention();
    });

    return {
        setChannels(channels) {
            const whatsappOnly = channels.length === 1 && channels[0] === 'whatsapp';
            for (const control of controls) {
                control.hidden = whatsappOnly && !listFormats.has(control.dataset.format);
                control.disabled = !document.queryCommandSupported(control.dataset.format);
            }
        },
        setValue(text, html) {
            savedRange = null;
            closeMention();
            if (html) {
                renderRichText(root, html);
            } else {
                root.replaceChildren();
                text.split(/\r?\n/u).forEach((line, index) => {
                    if (index > 0) root.append(document.createElement('br'));
                    root.append(document.createTextNode(line));
                });
            }
            updateCount();
        },
        value() {
            const text = root.innerText.trim();
            if (!text) return { text: '', html: '' };
            const clean = document.createElement('div');
            renderRichText(clean, root.innerHTML);
            return { text, html: clean.innerHTML };
        },
    };
}
