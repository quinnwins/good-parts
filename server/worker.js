// Free Claude for Good Parts: copies without a Claude key send their transcript prompt here, and this asks
// Claude with the owner's key (Max plan API credit). The key stays on Cloudflare as the secret CLAUDE_KEY.
// The extension owns the instructions and answer format, so copies friends already have keep working when
// those change. This owns the model and limits, and only takes Good Parts' kind of request.
// Runs as the Cloudflare Worker "good-parts" on the owner's Cloudflare account.

const PROMPT_START = 'Here is the transcript of the YouTube video';
// About 90k tokens, around 5 hours of captions. Haiku's lower price applies up to 100k.
const MAX_CHARS = 350000;

const CORS = {
  'access-control-allow-origin': 'https://www.youtube.com',
  'access-control-allow-methods': 'POST',
  'access-control-allow-headers': 'content-type',
};
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'content-type': 'application/json' } });

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (request.method !== 'POST') return reply(405, { error: 'Good Parts only' });
    const { text, schema } = await request.json().catch(() => ({}));
    if (typeof text !== 'string' || !text.startsWith(PROMPT_START) || text.length > MAX_CHARS || schema?.properties?.parts?.type !== 'array') {
      return reply(400, { error: 'Good Parts only' });
    }
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': env.CLAUDE_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-5-5',
        max_tokens: 16000,
        output_config: { effort: 'low', format: { type: 'json_schema', schema } },
        messages: [{ role: 'user', content: text }],
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) return reply(200, { stop_reason: data.stop_reason, content: data.content });
    console.log('Anthropic error', res.status, JSON.stringify(data.error));
    // The extension reads 429 as "busy or used up" and 5xx as "try again"; never pass on a key error,
    // or it would ask friends for a key they don't need.
    const outOfCredit = /credit balance/i.test(JSON.stringify(data.error || ''));
    const status = res.status === 429 || outOfCredit ? 429 : res.status >= 500 ? 503 : 502;
    return reply(status, { error: outOfCredit ? 'Out of free Claude for this month' : 'Claude had a problem' });
  },
};
