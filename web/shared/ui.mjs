import { icon } from './icons.mjs';

export const get = id => document.getElementById(id);
export const number = new Intl.NumberFormat();
export const groupPath = slug => `/api/campaign-groups/${encodeURIComponent(slug)}`;
export const campaignPage = slug => `/campaigns/${encodeURIComponent(slug)}`;

export function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
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

export function replayAnimation(node, className) {
    node.classList.remove(className);
    void node.offsetWidth;
    node.classList.add(className);
}

export async function request(url, options) {
    const response = await fetchOrExplain(url, options);
    if (response.status === 401) window.location.replace('/login');
    if (!response.ok) throw await responseError(response);
    if (response.status !== 204) return response.json();
}

export function sendJson(url, method, body) {
    return request(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
}

export async function whileBusy(control, action) {
    if (control.disabled) return;
    control.disabled = true;
    control.classList.add('busy');
    try {
        await action();
    } finally {
        control.disabled = false;
        control.classList.remove('busy');
    }
}

export function formFeedback(fields, generalErrorId) {
    const names = Object.keys(fields);
    const show = (field, message) => showFieldError(fields[field], `${field}-error`, message);
    return {
        show,
        clear() {
            for (const field of names) show(field, '');
            setError(generalErrorId, '');
        },
        validate(errors) {
            for (const field of names) show(field, errors[field]);
            const firstInvalid = names.find(field => errors[field]);
            if (firstInvalid) fields[firstInvalid].focus();
            return !firstInvalid;
        },
        report: error => reportError(fields, generalErrorId, show, error),
    };
}

function withIcon(node, text, iconName) {
    if (iconName) node.append(icon(iconName));
    node.append(element('span', 'label', text));
    return node;
}

async function fetchOrExplain(url, options) {
    try {
        return await fetch(url, options);
    } catch (error) {
        if (error.name === 'AbortError') throw error;
        throw new Error('Could not connect. Try again.', { cause: error });
    }
}

async function responseError(response) {
    const body = await response.json().catch(() => null);
    const error = new Error(body?.error || 'Could not complete this action. Try again.');
    error.field = body?.field;
    error.status = response.status;
    return error;
}

function showFieldError(control, errorId, message) {
    if (!control) return;
    setError(errorId, message);
    if (message) control.setAttribute('aria-invalid', 'true');
    else control.removeAttribute('aria-invalid');
}

function reportError(fields, generalErrorId, show, error) {
    const field = error.field === 'scriptHtml' ? 'script' : error.field;
    if (!Object.hasOwn(fields, field)) return setError(generalErrorId, error);
    show(field, error.message);
    fields[field].focus();
}
