import { icon } from './icons.mjs';

export const get = id => document.getElementById(id);
export const number = new Intl.NumberFormat();
export const campaignPath = id => `/api/campaigns/${encodeURIComponent(id)}`;

export function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function withIcon(node, text, iconName) {
    if (iconName) node.append(icon(iconName));
    node.append(element('span', 'label', text));
    return node;
}

export function button(text, onClick, className = 'button secondary small', iconName) {
    const node = withIcon(element('button', className), text, iconName);
    node.type = 'button';
    node.addEventListener('click', onClick);
    return node;
}

export function link(text, href, className = 'button secondary small', iconName) {
    const node = withIcon(element('a', className), text, iconName);
    node.href = href;
    return node;
}

export function setError(id, error) {
    const target = get(id);
    target.textContent = error instanceof Error ? error.message : error || '';
    target.hidden = !target.textContent;
}

let toastTimer;
export function toast(message) {
    const target = get('toast');
    window.clearTimeout(toastTimer);
    target.replaceChildren(icon('circle-check'), element('span', '', message));
    target.hidden = false;
    toastTimer = window.setTimeout(() => { target.hidden = true; }, 4000);
}

export async function request(url, options) {
    let response;
    try {
        response = await fetch(url, options);
    } catch (error) {
        if (error.name === 'AbortError') throw error;
        throw new Error('Could not connect. Try again.', { cause: error });
    }
    if (!response.ok) {
        const body = await response.json().catch(() => null);
        const error = new Error(body?.error || 'Could not complete this action. Try again.');
        error.field = body?.field;
        throw error;
    }
    if (response.status !== 204) return response.json();
}

export function formFeedback(fields, generalErrorId) {
    function show(field, message) {
        const control = fields[field];
        if (!control) return;
        setError(`${field}-error`, message);
        if (message) control.setAttribute('aria-invalid', 'true');
        else control.removeAttribute('aria-invalid');
    }

    return {
        show,
        clear() {
            for (const field of Object.keys(fields)) show(field, '');
            setError(generalErrorId, '');
        },
        validate(errors) {
            for (const field of Object.keys(fields)) show(field, errors[field]);
            const firstInvalid = Object.keys(fields).find(field => errors[field]);
            if (firstInvalid) fields[firstInvalid].focus();
            return !firstInvalid;
        },
        report(error) {
            const field = error.field === 'scriptHtml' ? 'script' : error.field;
            if (Object.hasOwn(fields, field)) {
                show(field, error.message);
                fields[field].focus();
            } else {
                setError(generalErrorId, error);
            }
        },
    };
}
