import { get, request, whileBusy } from './ui.mjs';
import { displayNameOf, fillAvatar } from './user.mjs';

const ROLE_LABELS = { admin: 'Administrator', operator: 'Operator' };

export function wireAccountNav({ onError } = {}) {
    request('/api/session').then(({ user }) => showUser(user)).catch(error => onError?.(error));
    wireMenu(get('user-menu'));
    const signOut = get('sign-out');
    signOut?.addEventListener('click', () => void whileBusy(signOut, async () => {
        try {
            await request('/auth/logout', { method: 'POST' });
            window.location.replace('/login');
        } catch (error) {
            onError?.(error);
        }
    }));
}

function showUser(user) {
    const name = displayNameOf(user);
    for (const id of ['user-avatar', 'user-menu-avatar-large']) {
        const avatar = get(id);
        if (avatar) fillAvatar(avatar, user);
    }
    setText('user-name', name);
    setText('user-menu-name', name);
    setText('user-menu-email', user.email);
    setText('user-menu-role', ROLE_LABELS[user.role] ?? user.role);
    const trigger = get('user-menu-trigger');
    if (trigger) trigger.title = `${name} (${user.email})`;
    for (const id of ['open-audit', 'user-menu-audit']) {
        const link = get(id);
        if (link) link.hidden = user.role !== 'admin';
    }
}

function setText(id, text) {
    const node = get(id);
    if (node) node.textContent = text;
}

function wireMenu(menu) {
    if (!menu) return;
    menu.addEventListener('click', event => {
        if (event.target.closest('a, button:not(summary)')) menu.open = false;
    });
    document.addEventListener('click', event => {
        if (menu.open && !menu.contains(event.target)) menu.open = false;
    });
    menu.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || !menu.open) return;
        menu.open = false;
        menu.querySelector('summary')?.focus();
    });
}
