// Lucide icons (ISC licence), loaded from /vendor/lucide.js as a classic script before the app modules.
const { createElement, icons } = window.lucide;

const componentName = name => name.replaceAll(/(?:^|-)([a-z0-9])/gu, (_, letter) => letter.toUpperCase());

/**
 * Returns a decorative SVG icon. Hover animations live in style.css and are keyed by the `icon-<name>` class,
 * so any button, link or label that contains an icon animates it.
 */
export function icon(name, size = 16) {
    const node = icons[componentName(name)];
    if (!node) throw new Error(`Unknown icon: ${name}`);
    return createElement(node, {
        class: `icon icon-${name}`,
        width: size,
        height: size,
        'stroke-width': 1.85,
        'aria-hidden': 'true',
        focusable: 'false',
    });
}

/** Replaces `<i data-icon="name">` placeholders in static markup with SVG icons. */
export function hydrateIcons(root = document) {
    for (const placeholder of root.querySelectorAll('i[data-icon]')) {
        placeholder.replaceWith(icon(placeholder.dataset.icon, Number(placeholder.dataset.size) || undefined));
    }
}
