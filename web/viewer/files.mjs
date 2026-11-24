import { extensionOf } from '../shared/labels.mjs';

const KINDS = {
    pdf: ['pdf'],
    image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'],
    text: ['txt', 'md', 'json', 'log'],
    csv: ['csv'],
    docx: ['docx'],
    sheet: ['xlsx'],
};
const loadingScripts = new Map();

export const fileUrl = name => `/api/attachments/${encodeURIComponent(name)}`;

/** Which preview to use for a file name, or "none". */
export function kindOf(name) {
    return Object.keys(KINDS).find(kind => KINDS[kind].includes(extensionOf(name))) ?? 'none';
}

export async function fetchFile(name, as) {
    const response = await fetch(fileUrl(name));
    if (!response.ok) throw new Error((await response.json().catch(() => null))?.error || 'The file could not be opened.');
    return as === 'text' ? response.text() : response.arrayBuffer();
}

/** Loads a vendor script on first use and returns the global it defines. */
export function loadScript(src, globalName) {
    if (window[globalName]) return Promise.resolve(window[globalName]);
    if (!loadingScripts.has(src)) loadingScripts.set(src, injectScript(src, globalName));
    return loadingScripts.get(src);
}

function injectScript(src, globalName) {
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.onload = () => resolve(window[globalName]);
        script.onerror = () => {
            loadingScripts.delete(src);
            reject(new Error('The document viewer could not load. Try again.'));
        };
        document.head.append(script);
    });
}
