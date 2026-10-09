// Free Claude for Good Parts: copies without a Claude key send a video's title and captions here, and this asks
// Claude with the owner's key (Max plan API credit). The key stays on Cloudflare as the secret CLAUDE_KEY.
// The instructions and answer format come from ../prompt.js, the same file the extension uses, and callers
// can't change them, so this can't be used as a free general-purpose Claude.
// Answers are saved in the D1 database "good-parts" (tables in schema.sql), so each video costs one Claude
// call however many people watch it, and each address gets DAILY_LIMIT new videos a day.
// Runs as the Cloudflare Worker "good-parts" on the owner's Cloudflare account.
import '../prompt.js';

const { FORMAT, transcriptPrompt, JSON_SCHEMA, sponsorPrompt, SPONSOR_JSON_SCHEMA } = globalThis.goodPartsPrompt;
// About 90k tokens, around 5 hours of captions. Haiku's lower price applies up to 100k.
const MAX_CHARS = 350000;
const DAILY_LIMIT = 30; // New videos per address per day (UTC). Saved ones don't count.

const CORS = {
  'access-control-allow-origin': 'https://www.youtube.com',
  'access-control-allow-methods': 'POST',
  'access-control-allow-headers': 'content-type',
};
const send = (status, text) => new Response(text, { status, headers: { ...CORS, 'content-type': 'application/json' } });
const reply = (status, body) => send(status, JSON.stringify(body));
const sha256 = async (text) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('');

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (request.method !== 'POST') return reply(405, { error: 'Good Parts only' });
    const { format, task, title, lines } = (await request.json().catch(() => null)) || {};
    // task 'sponsors': just the sponsor reads, for videos SponsorBlock hasn't marked. Anything else: the good parts.
    const sponsors = task === 'sponsors';
    if (typeof title !== 'string' || typeof lines !== 'string' || !lines.trim() || title.length + lines.length > MAX_CHARS) {
      return reply(400, { error: 'Good Parts only' });
    }
    // The extension shows 409 as "out of date": its copy expects an answer format this server no longer gives.
    if (format !== FORMAT) return reply(409, { error: 'Old Good Parts' });
    // Saved by captions, not title: YouTube puts a notification count like "(3)" in some viewers' titles.
    const key = `${sponsors ? 'sponsors' : FORMAT}:${await sha256(lines)}`;
    const saved = await env.DB.prepare('SELECT body FROM answers WHERE key = ?').bind(key).first('body');
    if (saved) return send(200, saved);
    // Sponsor checks run on their own, so they're counted apart and never use up anyone's good parts.
    const ip = request.headers.get('cf-connecting-ip');
    const used = await env.DB.prepare('INSERT INTO uses (ip, day, n) VALUES (?, ?, 1) ON CONFLICT (ip, day) DO UPDATE SET n = n + 1 RETURNING n')
      .bind(sponsors ? `sponsors ${ip}` : ip, new Date().toISOString().slice(0, 10))
      .first('n');
    if (used > DAILY_LIMIT) return reply(429, { error: 'Daily limit reached' });
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': env.CLAUDE_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-5-5',
        max_tokens: 16000,
        output_config: { effort: 'low', format: { type: 'json_schema', schema: sponsors ? SPONSOR_JSON_SCHEMA : JSON_SCHEMA } },
        messages: [{ role: 'user', content: (sponsors ? sponsorPrompt : transcriptPrompt)(title, lines) }],
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      const body = JSON.stringify({ stop_reason: data.stop_reason, content: data.content });
      // Only finished answers are saved; a refusal or a cut-off answer is asked again next time.
      if (data.stop_reason === 'end_turn') {
        ctx.waitUntil(env.DB.prepare('INSERT OR IGNORE INTO answers (key, body, created) VALUES (?, ?, ?)').bind(key, body, Date.now()).run());
      }
      return send(200, body);
    }
    console.log('Anthropic error', res.status, JSON.stringify(data.error));
    // The extension reads 429 as "busy or used up" and 5xx as "try again"; never pass on a key error,
    // or it would ask friends for a key they don't need.
    const outOfCredit = /credit balance/i.test(JSON.stringify(data.error || ''));
    const status = res.status === 429 || outOfCredit ? 429 : res.status >= 500 ? 503 : 502;
    return reply(status, { error: outOfCredit ? 'Out of free Claude for this month' : 'Claude had a problem' });
  },
};
