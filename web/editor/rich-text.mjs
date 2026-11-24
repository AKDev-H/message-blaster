const FORMATTING_TAGS = new Set(['p', 'div', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'del', 'ul', 'ol', 'li', 'blockquote']);
const DISCARDED_TAGS = new Set(['script', 'style', 'template', 'svg', 'math', 'iframe', 'object']);

export function renderRichText(target, html) {
    const template = document.createElement('template');
    template.innerHTML = html;
    const fragment = document.createDocumentFragment();
    copySafeNodes(template.content, fragment);
    target.replaceChildren(fragment);
}

export function textWithBreaks(text) {
    const fragment = document.createDocumentFragment();
    text.split(/\r?\n/u).forEach((line, index) => {
        if (index > 0) fragment.append(document.createElement('br'));
        fragment.append(document.createTextNode(line));
    });
    return fragment;
}

function copySafeNodes(source, target) {
    for (const child of source.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) target.append(document.createTextNode(child.data));
        else if (child.nodeType === Node.ELEMENT_NODE && !DISCARDED_TAGS.has(child.localName)) copyElement(child, target);
    }
}

function copyElement(child, target) {
    if (!FORMATTING_TAGS.has(child.localName)) return copySafeNodes(child, target);
    const node = document.createElement(child.localName);
    copySafeNodes(child, node);
    target.append(node);
}
