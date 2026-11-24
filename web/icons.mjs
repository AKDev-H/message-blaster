const { createElement, icons } = window.lucide;

const componentName = name => name.replaceAll(/(?:^|-)([a-z0-9])/gu, (_, letter) => letter.toUpperCase());

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

export function hydrateIcons(root = document) {
    for (const placeholder of root.querySelectorAll('i[data-icon]')) {
        placeholder.replaceWith(icon(placeholder.dataset.icon, Number(placeholder.dataset.size) || undefined));
    }
}
