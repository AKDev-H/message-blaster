import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';

export interface GoogleIdentity {
    subject: string;
    email: string;
    emailVerified: boolean;
    hostedDomain?: string;
    nonce?: string;
}

export interface GoogleProvider {
    authorize(input: { state: string; nonce: string; challenge: string }): string;
    exchange(input: { code: string; verifier: string }): Promise<GoogleIdentity>;
}

interface GoogleClientConfig {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
}

export function createGoogleProvider(config: GoogleClientConfig): GoogleProvider {
    const client = new OAuth2Client({ ...config, transporterOptions: { timeout: 10_000 } });
    return {
        authorize: ({ state, nonce, challenge }) => client.generateAuthUrl({
            scope: ['openid', 'email'],
            prompt: 'select_account',
            state,
            nonce,
            code_challenge: challenge,
            code_challenge_method: CodeChallengeMethod.S256,
        }),
        async exchange({ code, verifier }) {
            const { tokens } = await client.getToken({ code, codeVerifier: verifier });
            if (!tokens.id_token) throw new Error('Google did not return an identity token.');
            const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: config.clientId });
            const claims = ticket.getPayload();
            if (!claims?.sub || !claims.email || (claims.azp && claims.azp !== config.clientId)) {
                throw new Error('Google did not return a valid identity.');
            }
            return {
                subject: claims.sub,
                email: claims.email,
                emailVerified: claims.email_verified === true,
                ...(claims.hd && { hostedDomain: claims.hd }),
                ...(claims.nonce && { nonce: claims.nonce }),
            };
        },
    };
}
