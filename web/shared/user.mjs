export function userNameFromEmail(email) {
    if (!email || typeof email !== 'string') return 'User';
    const local = email.split('@')[0] || '';
    const cleaned = local.replace(/[._-]+/gu, ' ').trim();
    if (!cleaned) return 'User';
    return cleaned
        .split(/\s+/u)
        .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(' ');
}

export function userInitials(name) {
    if (!name || typeof name !== 'string') return 'U';
    const parts = name.trim().split(/\s+/u).filter(Boolean);
    if (!parts.length) return 'U';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts.at(-1)[0]).toUpperCase();
}

export function displayNameOf(user) {
    return user?.name?.trim() || userNameFromEmail(user?.email);
}

export function fillAvatar(target, user) {
    const name = displayNameOf(user);
    const initials = document.createTextNode(userInitials(name));
    target.replaceChildren(initials);
    if (!user?.picture) return;
    const photo = document.createElement('img');
    photo.alt = '';
    photo.referrerPolicy = 'no-referrer';
    photo.decoding = 'async';
    photo.addEventListener('load', () => target.replaceChildren(photo), { once: true });
    photo.src = user.picture;
}
