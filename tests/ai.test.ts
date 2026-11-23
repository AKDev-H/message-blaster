import assert from 'node:assert/strict';
import test from 'node:test';
import { AiError, generateDraft, sharedVariables } from '../src/services/ai.service.js';

const env = { GROQ_API_KEY: 'test-key', GROQ_MODEL: 'openai/gpt-oss-120b' };

function reply(content: unknown, status = 200): typeof fetch {
    return async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { status });
}

test('shared variables exclude channel-specific addresses when sending to both channels', () => {
    assert.deepEqual(sharedVariables(['gmail', 'whatsapp']), ['client_name', 'client_id', 'campaign_id', 'pdf_filename']);
    assert.ok(sharedVariables(['whatsapp']).includes('phone_number'));
});

test('Groq drafts are sanitized and keep only known placeholders', async () => {
    let sent: { model: string; messages: { role: string; content: string }[]; response_format: { type: string } } | undefined;
    const fetcher: typeof fetch = async (_url, init) => {
        sent = JSON.parse(String(init?.body));
        return reply({
            subject: 'Hi {{client_name}}\n{{phone_number}}',
            message: '<p>Hi <b>{{client_name}}</b> {{discount_code}}</p><script>x()</script><img src=x onerror=y>',
        })(_url, init);
    };
    const draft = await generateDraft(env, { prompt: 'Invite clients', channels: ['gmail', 'whatsapp'], message: 'Old' }, fetcher);

    assert.equal(sent?.model, 'openai/gpt-oss-120b');
    assert.equal(sent?.response_format.type, 'json_schema');
    assert.match(sent?.messages[0]?.content ?? '', /\{\{client_name\}\}/u);
    assert.doesNotMatch(sent?.messages[0]?.content ?? '', /email_address|phone_number/u);
    assert.match(sent?.messages[1]?.content ?? '', /Revise this draft:\nCurrent message:\nOld/u);
    assert.equal(draft.subject, 'Hi {{client_name}}');
    assert.equal(draft.html, '<p>Hi <b>{{client_name}}</b> </p>');
    assert.equal(draft.text, 'Hi {{client_name}}');
});

test('WhatsApp-only drafts have no subject', async () => {
    const draft = await generateDraft(env, { prompt: 'Hello', channels: ['whatsapp'] }, reply({ subject: 'Ignored', message: '<p>Hey</p>' }));
    assert.equal(draft.subject, '');
});

test('Groq failures become readable errors', async () => {
    await assert.rejects(generateDraft({ ...env, GROQ_API_KEY: '' }, { prompt: 'Hi', channels: ['gmail'] }), /not set up/u);
    await assert.rejects(generateDraft(env, { prompt: 'Hi', channels: ['gmail'] }, reply({}, 401)), /rejected the API key/u);
    await assert.rejects(generateDraft(env, { prompt: 'Hi', channels: ['gmail'] }, reply({}, 429)), /busy/u);
    await assert.rejects(generateDraft(env, { prompt: 'Hi', channels: ['gmail'] }, reply({ subject: '', message: '<p> </p>' })), AiError);
    await assert.rejects(generateDraft(env, { prompt: 'Hi', channels: ['gmail'] }, async () => { throw new TypeError('offline'); }), /Could not reach/u);
});
