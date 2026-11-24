import { readdir, readFile } from 'node:fs/promises';

export type Assets = Map<string, { body: Buffer; type: string }>;
export type StatusPage = 'not-found' | 'server-error' | 'maintenance';
export type StatusPages = Map<StatusPage, Buffer>;

const SCRIPT = 'text/javascript; charset=utf-8';
const FONT = 'font/woff2';
const SVG = 'image/svg+xml';
const FONTS = '../../node_modules/@fontsource-variable';
const JSON_TYPE = 'application/json; charset=utf-8';
const WEB_DIRECTORY = new URL('../../web/', import.meta.url);
const STATUS_PAGE_FILES: Record<StatusPage, string> = {
    'not-found': '../../web/pages/404.html',
    'server-error': '../../web/pages/500.html',
    maintenance: '../../web/pages/maintenance.html',
};

const ASSET_FILES: readonly (readonly [string, string, string])[] = [
    ['/', '../../web/index.html', 'text/html; charset=utf-8'],
    ['/style.css', '../../web/style.css', 'text/css; charset=utf-8'],
    ['/brand.css', '../../web/brand.css', 'text/css; charset=utf-8'],
    ['/pages.css', '../../web/pages.css', 'text/css; charset=utf-8'],
    ['/vendor/lottie.js', '../../node_modules/lottie-web/build/player/lottie_light.min.js', SCRIPT],
    ['/favicon.svg', '../../web/favicon.svg', SVG],
    ['/favicon.ico', '../../web/favicon.svg', SVG],
    ['/vendor/lucide.js', '../../node_modules/lucide/dist/umd/lucide.min.js', SCRIPT],
    ['/vendor/mammoth.js', '../../node_modules/mammoth/mammoth.browser.min.js', SCRIPT],
    ['/vendor/exceljs.js', '../../node_modules/exceljs/dist/exceljs.min.js', SCRIPT],
    ['/fonts/bricolage.woff2', `${FONTS}/bricolage-grotesque/files/bricolage-grotesque-latin-standard-normal.woff2`, FONT],
    ['/fonts/instrument.woff2', `${FONTS}/instrument-sans/files/instrument-sans-latin-standard-normal.woff2`, FONT],
    ['/fonts/instrument-italic.woff2', `${FONTS}/instrument-sans/files/instrument-sans-latin-standard-italic.woff2`, FONT],
];

export async function loadAssets(): Promise<Assets> {
    const files = [...ASSET_FILES, ...await webModules(), ...await animations()];
    const entries = await Promise.all(files.map(async ([route, path, type]) => {
        return [route, { body: await readFile(new URL(path, import.meta.url)), type }] as const;
    }));
    return new Map(entries);
}

async function webModules(): Promise<(readonly [string, string, string])[]> {
    const paths = (await readdir(WEB_DIRECTORY, { recursive: true })).filter(path => path.endsWith('.mjs'));
    return paths.map(path => path.replaceAll('\\', '/')).map(path => [`/${path}`, `../../web/${path}`, SCRIPT] as const);
}

async function animations(): Promise<(readonly [string, string, string])[]> {
    const names = (await readdir(new URL('animations/', WEB_DIRECTORY))).filter(name => name.endsWith('.json'));
    return names.map(name => [`/animations/${name}`, `../../web/animations/${name}`, JSON_TYPE] as const);
}

export async function loadStatusPages(): Promise<StatusPages> {
    const entries = await Promise.all(Object.entries(STATUS_PAGE_FILES).map(async ([name, path]) => {
        return [name as StatusPage, await readFile(new URL(path, import.meta.url))] as const;
    }));
    return new Map(entries);
}
