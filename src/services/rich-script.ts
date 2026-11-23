import { compile } from 'html-to-text';
import sanitizeHtml from 'sanitize-html';
import { MAX_SCRIPT_HTML_LENGTH } from '../config/constants.js';
import { renderTemplate } from '../utils/template.util.js';

const scriptTags = [
    'p', 'div', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del',
    'ul', 'ol', 'li', 'blockquote',
];

const plainText = compile({ wordwrap: false });

export function cleanScriptHtml(html: string): string {
    return sanitizeHtml(html, {
        allowedTags: scriptTags,
        allowedAttributes: {},
        nonTextTags: ['script', 'style', 'textarea', 'option', 'xmp', 'noscript', 'iframe', 'object', 'template', 'svg', 'math'],
        nestingLimit: 30,
    });
}

export function scriptText(html: string): string {
    return plainText(html).trim();
}

function escapeHtml(text: string): string {
    return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function renderRichScript(template: string, values: Readonly<Record<string, string>>) {
    const escapedValues = Object.fromEntries(Object.entries(values).map(([key, text]) => [key, escapeHtml(text)]));
    const rendered = renderTemplate(template, escapedValues);
    if (rendered.length > MAX_SCRIPT_HTML_LENGTH) throw new Error('The formatted message is too long.');
    const html = cleanScriptHtml(rendered);
    return { html, text: scriptText(html) };
}
