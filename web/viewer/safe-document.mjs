const DOCUMENT_TAGS = new Set(['p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'sub', 'sup', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'blockquote', 'a', 'img']);
const INLINE_IMAGE = /^data:image\/(png|jpe?g|gif|webp);base64,/iu;

export function appendSafeDocument(source, target) {
    for (const child of source.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) target.append(child.data);
        else if (child.nodeType === Node.ELEMENT_NODE) appendSafeElement(child, target);
    }
}

function appendSafeElement(child, target) {
    const tag = child.localName;
    if (!DOCUMENT_TAGS.has(tag)) return appendSafeDocument(child, target);
    if (tag === 'img' && !INLINE_IMAGE.test(child.getAttribute('src') ?? '')) return;
    const node = document.createElement(tag === 'a' ? 'span' : tag);
    if (tag === 'img') copyImage(child, node);
    copyCellSpans(child, node);
    appendSafeDocument(child, node);
    target.append(node);
}

function copyImage(source, image) {
    image.src = source.getAttribute('src');
    image.alt = source.getAttribute('alt') ?? '';
}

function copyCellSpans(source, node) {
    for (const name of ['colspan', 'rowspan']) {
        const value = Number(source.getAttribute(name));
        if (Number.isInteger(value) && value > 1 && value < 100) node.setAttribute(name, String(value));
    }
}
