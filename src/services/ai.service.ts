import type { Environment } from '../config/env.js';
import type { CampaignChannel } from '../types/index.js';
import { cleanScriptHtml, scriptText } from './rich-script.js';

const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const TIMEOUT_MS = 30_000;

export const CHANNEL_VARIABLES: Record<CampaignChannel, readonly string[]> = {
    gmail: ['client_name', 'email_address', 'campaign_id', 'pdf_filename'],
    whatsapp: ['client_name', 'phone_number', 'campaign_id', 'pdf_filename'],
};

const VARIABLE_MEANING: Record<string, string> = {
    client_name: 'the recipient’s name',
    email_address: 'the recipient’s email address',
    phone_number: 'the recipient’s phone number',
    campaign_id: 'the campaign name',
    pdf_filename: 'the attached PDF’s file name',
};

const RESPONSE_SCHEMA = {
    type: 'object',
    properties: {
        subject: { type: 'string', description: 'Email subject line, plain text, one line.' },
        message: { type: 'string', description: 'Message body as simple HTML.' },
    },
    required: ['subject', 'message'],
    additionalProperties: false,
} as const;

const HTTP_ERRORS: Record<number, string> = {
    401: 'The AI service rejected the API key.',
    429: 'The AI service is busy. Try again in a minute.',
};

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

type AiSettings = Pick<Environment, 'GROQ_API_KEY' | 'GROQ_MODEL'>;
type RawDraft = { subject?: unknown; message?: unknown };

export function sharedVariables(channels: readonly CampaignChannel[]): string[] {
    const [first, ...rest] = channels;
    if (!first) return [];
    return CHANNEL_VARIABLES[first].filter(name => rest.every(channel => CHANNEL_VARIABLES[channel].includes(name)));
}

export async function generateDraft(env: AiSettings, input: DraftRequest, fetcher: typeof fetch = fetch): Promise<GeneratedDraft> {
    if (!env.GROQ_API_KEY) throw new AiError('AI writing is not set up yet.');
    const variables = sharedVariables(input.channels);
    const response = await callAiService(env, input, variables, fetcher);
    return cleanDraft(await readDraft(response), input.channels, variables);
}

async function callAiService(env: AiSettings, input: DraftRequest, variables: readonly string[], fetcher: typeof fetch) {
    let response: Response;
    try {
        response = await fetcher(ENDPOINT, requestOptions(env, input, variables));
    } catch {
        throw new AiError('Could not reach the AI service. Try again.');
    }
    if (!response.ok) throw new AiError(HTTP_ERRORS[response.status] ?? 'The AI service could not write a draft. Try again.');
    return response;
}

function requestOptions(env: AiSettings, input: DraftRequest, variables: readonly string[]): RequestInit {
    const messages = [
        { role: 'system', content: instructions(input.channels, variables) },
        { role: 'user', content: userMessage(input) },
    ];
    const responseFormat = { type: 'json_schema', json_schema: { name: 'campaign_draft', strict: true, schema: RESPONSE_SCHEMA } };
    return {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: env.GROQ_MODEL, temperature: 0.6, messages, response_format: responseFormat }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    };
}

function instructions(channels: readonly CampaignChannel[], variables: readonly string[]): string {
    return [
        'You write outreach messages for a sales team. Recipients have opted in to hear from the sender.',
        `The message is sent over ${channels.map(channel => (channel === 'gmail' ? 'email' : 'WhatsApp')).join(' and ')}.`,
        'Personalize with these placeholders only, written exactly as shown, never inventing others:',
        ...variables.map(name => `- {{${name}}}: ${VARIABLE_MEANING[name]}`),
        'Return JSON with "subject" and "message".',
        channels.includes('gmail') ? '"subject": a specific email subject under 80 characters. Placeholders are allowed.' : '"subject": an empty string.',
        `"message": HTML using only <p>, <br>, <b>, <i>, <u>, <ul>, <ol> and <li>. ${lengthGuidance(channels)}`,
        'Be clear and warm. Avoid hype, false urgency, and claims the user did not provide. Do not add a signature placeholder.',
        'Write in the language of the user’s request.',
    ].join('\n');
}

function lengthGuidance(channels: readonly CampaignChannel[]): string {
    const whatsappOnly = channels.length === 1 && channels[0] === 'whatsapp';
    return whatsappOnly ? 'Keep it under 600 characters and conversational, as WhatsApp messages are short.' : 'Keep it under 180 words.';
}

function userMessage(input: DraftRequest): string {
    const current = [input.subject && `Current subject: ${input.subject}`, input.message && `Current message:\n${input.message}`]
        .filter(Boolean).join('\n\n');
    return current ? `${input.prompt}\n\nRevise this draft:\n${current}` : input.prompt;
}

async function readDraft(response: Response): Promise<RawDraft> {
    try {
        const body = await response.json() as { choices?: { message?: { content?: string } }[] };
        return JSON.parse(body.choices?.[0]?.message?.content ?? '') as RawDraft;
    } catch {
        throw new AiError('The AI service returned an unreadable draft. Try again.');
    }
}

function cleanDraft(draft: RawDraft, channels: readonly CampaignChannel[], variables: readonly string[]): GeneratedDraft {
    const html = cleanScriptHtml(keepKnownVariables(typeof draft.message === 'string' ? draft.message : '', variables));
    const text = scriptText(html);
    if (!text) throw new AiError('The AI service returned an empty draft. Try a more specific request.');
    const subject = channels.includes('gmail') && typeof draft.subject === 'string' ? cleanSubject(draft.subject, variables) : '';
    return { subject, html, text };
}

function cleanSubject(subject: string, variables: readonly string[]): string {
    // eslint-disable-next-line no-control-regex -- Subjects are a single header line.
    return keepKnownVariables(subject, variables).replaceAll(/[\u0000-\u001f\u007f]+/gu, ' ').trim().slice(0, 255);
}

function keepKnownVariables(value: string, variables: readonly string[]): string {
    return value.replaceAll(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/gu, (_match: string, name: string) =>
        variables.includes(name) ? `{{${name}}}` : '');
}
