'use strict';

const OpenAI = require('openai');

let _client = null;

function getClient(apiKey) {
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured.');
  if (_client) return _client;
  _client = new OpenAI({ apiKey });
  return _client;
}

/**
 * Ask the LLM for the next tool call. Strict JSON mode — the model must
 * return one of:
 *   { "tool": "<name>", "input": { ... } }
 *   { "final": "<message to user>" }
 */
async function nextStep({ apiKey, model, systemPrompt, history }) {
  const client = getClient(apiKey);
  const resp = await client.chat.completions.create({
    model: model || 'gpt-4o-mini',
    response_format: { type: 'json_object' },
    temperature: 0.1,
    messages: [
      { role: 'system', content: systemPrompt },
      ...history,
    ],
  });
  const text = resp.choices?.[0]?.message?.content || '{}';
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`LLM returned invalid JSON: ${text.slice(0, 200)}`);
  }
  return parsed;
}

module.exports = { nextStep };
