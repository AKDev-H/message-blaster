import { createGoogleProvider, type GoogleProvider } from '../../auth/google.js';

export interface WebAuthOptions {
    origin?: string;
    provider?: GoogleProvider;
}

export function webAuthConfig(options: WebAuthOptions, port: number) {
    const origin = parseOrigin(options.origin ?? (process.env.WEB_PUBLIC_ORIGIN?.trim() || `http://127.0.0.1:${port}`));
    if (options.provider) return { origin, createProvider: (_origin: URL) => options.provider! };
    const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
    if (!clientId || !clientSecret) throw new Error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET before starting the dashboard.');
    return {
        origin,
        createProvider: (publicOrigin: URL) => createGoogleProvider({
            clientId, clientSecret, redirectUri: new URL('/auth/callback', publicOrigin).href,
        }),
    };
}

function parseOrigin(value: string): URL {
    const url = URL.parse(value);
    const local = url && ['localhost', '127.0.0.1'].includes(url.hostname);
    if (!url || (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))
        || (value !== url.origin && value !== `${url.origin}/`)) {
        throw new Error('WEB_PUBLIC_ORIGIN must be a canonical HTTPS origin or a localhost HTTP origin.');
    }
    return url;
}
