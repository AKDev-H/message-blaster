import type { Environment } from '../config/env.js';
import type { CampaignChannel } from '../types/index.js';
import { cleanScriptHtml, scriptText } from './rich-script.js';

const endpoint = 'https://api.groq.com/openai/v1/chat/completions';
const timeoutMs = 30_000;

export const CHANNEL_VARIABLES: Record<CampaignChannel, readonly string[]> = {
    gmail: ['client_name', 'email_address', 'campaign_id', 'pdf_filename'],
    whatsapp: ['client_name', 'phone_number', 'campaign_id', 'pdf_filename'],
};

const variableMeaning: Record<string, string> = {
    client_name: 'the recipient’s name',
    email_address: 'the recipient’s email address',
    phone_number: 'the recipient’s phone number',
    campaign_id: 'the campaign name',
    pdf_filename: 'the attached PDF’s file name',
};

const responseSchema = {
    type: 'object',
    properties: {
        subject: { type: 'string', description: 'Email subject line, plain text, one line.' },
        message: { type: 'string', description: 'Message body as simple HTML.' },
    },
    required: ['subject', 'message'],
    additionalProperties: false,
} as const;

export class AiError extends Error {}

export interface DraftRequest {
    prompt: string;
    channels: readonly CampaignChannel[];
    subject?: string;
    message?: string;
}

export interface GeneratedDraft {
    subject: string;
    html: string;
    text: string;
}

export function sharedVariables(channels: readonly CampaignChannel[]): string[] {
    const [first, ...rest] = channels;
    if (!first) return [];
    return CHANNEL_VARIABLES[first].filter(name => rest.every(channel => CHANNEL_VARIABLES[channel].includes(name)));
}

function instructions(channels: readonly CampaignChannel[], variables: readonly string[]): string {
    const gmail = channels.includes('gmail');
    const whatsappOnly = channels.length === 1 && channels[0] === 'whatsapp';
    return [
        'You write outreach messages for a sales team. Recipients have opted in to hear from the sender.',
        `The message is sent over ${channels.map(channel => (channel === 'gmail' ? 'email' : 'WhatsApp')).join(' and ')}.`,
        'Personalize with these placeholders only, written exactly as shown, never inventing others:',
        ...variables.map(name => `- {{${name}}}: ${variableMeaning[name]}`),
        'Return JSON with "subject" and "message".',
        gmail ? '"subject": a specific email subject under 80 characters. Placeholders are allowed.' : '"subject": an empty string.',
        `"message": HTML using only <p>, <br>, <b>, <i>, <u>, <ul>, <ol> and <li>. ${whatsappOnly
            ? 'Keep it under 600 characters and conversational, as WhatsApp messages are short.'
            : 'Keep it under 180 words.'}`,
        'Be clear and warm. Avoid hype, false urgency, and claims the user did not provide. Do not add a signature placeholder.',
        'Write in the language of the user’s request.',
    ].join('\n');
}

function keepKnownVariables(value: string, variables: readonly string[]): string {
    return value.replaceAll(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/gu, (_match: string, name: string) =>
        variables.includes(name) ? `{{${name}}}` : '');
}

export async function generateDraft(env: Pick<Environment, 'GROQ_API_KEY' | 'GROQ_MODEL'>, input: DraftRequest,
    fetcher: typeof fetch = fetch): Promise<GeneratedDraft> {
    if (!env.GROQ_API_KEY) throw new AiError('AI writing is not set up yet.');
    const variables = sharedVariables(input.channels);
    const current = [input.subject && `Current subject: ${input.subject}`, input.message && `Current message:\n${input.message}`]
        .filter(Boolean).join('\n\n');

    let response: Response;
    try {
        response = await fetcher(endpoint, {
            method: 'POST',
            headers: { Authorization: `Bearer ${env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: env.GROQ_MODEL,
                temperature: 0.6,
                messages: [
                    { role: 'system', content: instructions(input.channels, variables) },
                    { role: 'user', content: current ? `${input.prompt}\n\nRevise this draft:\n${current}` : input.prompt },
                ],
                response_format: { type: 'json_schema', json_schema: { name: 'campaign_draft', strict: true, schema: responseSchema } },
            }),
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch {
        throw new AiError('Could not reach the AI service. Try again.');
    }
    if (response.status === 401) throw new AiError('The AI service rejected the API key.');
    if (response.status === 429) throw new AiError('The AI service is busy. Try again in a minute.');
    if (!response.ok) throw new AiError('The AI service could not write a draft. Try again.');

    let draft: { subject?: unknown; message?: unknown };
    try {
        const body = await response.json() as { choices?: { message?: { content?: string } }[] };
        draft = JSON.parse(body.choices?.[0]?.message?.content ?? '') as typeof draft;
    } catch {
        throw new AiError('The AI service returned an unreadable draft. Try again.');
    }
    const html = cleanScriptHtml(keepKnownVariables(typeof draft.message === 'string' ? draft.message : '', variables));
    const text = scriptText(html);
    if (!text) throw new AiError('The AI service returned an empty draft. Try a more specific request.');
    const subject = input.channels.includes('gmail') && typeof draft.subject === 'string'
        // eslint-disable-next-line no-control-regex -- Subjects are a single header line.
        ? keepKnownVariables(draft.subject, variables).replaceAll(/[\u0000-\u001f\u007f]+/gu, ' ').trim().slice(0, 255)
        : '';
    return { subject, html, text };
}
