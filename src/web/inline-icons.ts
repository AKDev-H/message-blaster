import { icons } from 'lucide';

type IconNode = [tag: string, attrs: Record<string, string | number>][];

const PLACEHOLDER = /<i data-icon="([a-z0-9-]+)"(?: data-size="(\d+)")?><\/i>/gu;
const DEFAULT_SIZE = 16;
const BASE_ATTRIBUTES = {
    xmlns: 'http://www.w3.org/2000/svg',
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': 1.85,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    focusable: 'false',
};

const componentName = (name: string) => name.replaceAll(/(?:^|-)([a-z0-9])/gu, (_, letter: string) => letter.toUpperCase());

export function iconSvg(name: string, size = DEFAULT_SIZE): string {
    const node = (icons as Record<string, IconNode>)[componentName(name)];
    if (!node) throw new Error(`Unknown icon: ${name}`);
    const attributes = { class: `icon icon-${name}`, width: size, height: size, ...BASE_ATTRIBUTES };
    const children = node.map(([tag, attrs]) => `<${tag}${serialize(attrs)}/>`).join('');
    return `<svg${serialize(attributes)}>${children}</svg>`;
}

export function inlineIcons(html: string): string {
    return html.replaceAll(PLACEHOLDER, (_, name: string, size?: string) => iconSvg(name, Number(size) || undefined));
}

function serialize(attrs: Record<string, string | number>): string {
    return Object.entries(attrs).map(([key, value]) => ` ${key}="${String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"`).join('');
}
