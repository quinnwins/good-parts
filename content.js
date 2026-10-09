const LEAD_IN = 2; // The AI's starts can land mid-sentence, so begin each part a moment early.
const BACKUP_AFTER = 75000;
const GIVE_UP_AFTER = 180000;
// Without a Claude key, Claude goes through the Good Parts server (server/worker.js), so friends' copies need no key.
const FREE_CLAUDE = 'https://good-parts.quinnwins.workers.dev';

const HIGHLIGHTS = 0.25; // Share of the video that plays at the viewer's own speed.
const SKIPPED = 0.25; // Share of the video skipped at the least, weakest parts first.

const LONG_VIDEO = 8 * 60; // Only videos this long are worked out early: YouTube allows mid-video ads from 8 min, so talk videos get padded past it.
const WORK_OUT_AFTER = 30; // Seconds watched before that happens.

// Captions that say any of these may have a sponsor read, so they go to the AI when SponsorBlock has nothing.
const SPONSOR_WORDS = /sponsor|brought to you by|made possible by|promo code|discount code|coupon code|use code|use my code|partner(ed|ing)? with|in partnership with|free trial|% off|percent off/i;

// loading: the parts being worked out ({ id, quiet, promise }). openGap: a skipped stretch the viewer went
// back to on purpose, which plays until the next part.
let state = { videoId: null, parts: null, on: false, busy: false, markersFor: null, baseRate: 1, current: null, loading: null, openGap: null };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const player = () => document.querySelector('#movie_player');
const video = () => document.querySelector('#movie_player video');
const adShowing = () => player()?.classList.contains('ad-showing');

function currentVideoId() {
  return location.pathname === '/watch' ? new URLSearchParams(location.search).get('v') : null;
}

function toSeconds(ts) {
  // The AI often copies the transcript's brackets, e.g. "[3:12]".
  const nums = String(ts).replace(/[^\d:.]/g, '').split(':').map(Number);
  return nums.some(Number.isNaN) ? NaN : nums.reduce((total, n) => total * 60 + n, 0);
}

function clock(sec) {
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

// Sort, add the lead-in, pick the highlights, and tidy the edges: merge same-kind parts that overlap or
// sit a blink apart (a 1-second skip is just jarring), and never let two parts overlap.
function cleanParts(raw) {
  let parts = raw
    .map((p) => ({ start: toSeconds(p.start), end: toSeconds(p.end), score: p.score, label: p.label }))
    .filter((p) => p.end > p.start);
  const length = Math.max(0, ...parts.map((p) => p.end));
  // The AI keeps nearly everything: it left out 3-12% of test videos, so playback hardly ever jumped. So the
  // weakest-scored parts are skipped too, until about a quarter of the video is. Among equal scores the longest
  // go first, for fewer jumps. In testing this still kept 96-100% of the key moments.
  let skipped = length - parts.reduce((sum, p) => sum + (p.end - p.start), 0);
  const weak = new Set();
  for (const p of [...parts].sort((a, b) => a.score - b.score || (b.end - b.start) - (a.end - a.start))) {
    if (skipped >= SKIPPED * length) break;
    weak.add(p);
    skipped += p.end - p.start;
  }
  parts = parts
    .filter((p) => !weak.has(p))
    .map((p) => ({ ...p, start: Math.max(0, p.start - LEAD_IN) }))
    .sort((a, b) => a.start - b.start);
  // Asked for "about a quarter", the AI marked 42-61% of a video as highlights. So it scores each part, and
  // the best-scored parts become highlights until they fill a quarter of the video. The best one always does.
  const budget = HIGHLIGHTS * length;
  let used = 0;
  for (const p of [...parts].sort((a, b) => b.score - a.score)) {
    const highlight = used === 0 || used + (p.end - p.start) <= budget;
    p.kind = highlight ? 'highlight' : 'play';
    if (highlight) used += p.end - p.start;
  }
  const out = [];
  for (const p of parts) {
    const last = out[out.length - 1];
    if (last && p.start <= last.end + 2) {
      if (p.kind === last.kind) {
        last.end = Math.max(last.end, p.end);
        continue;
      }
      if (p.end <= last.end) continue; // Swallowed by the part before it.
      if (p.start < last.end) p.start = last.end;
      else last.end = p.start;
    }
    out.push(p);
  }
  return out;
}

// `retry` marks hiccups on the AI's side that are worth asking again about.
// `settings` marks problems fixed in the settings tab, which a click then opens (a background run never does).
class FriendlyError extends Error {
  constructor(message, retry = false, settings = false) {
    super(message);
    this.retry = retry;
    this.settings = settings;
  }
}

// One POST to an AI, with its failures turned into messages people can act on.
async function post(name, url, headers, body, signal) {
  const res = await fetch(url, {
    signal,
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }).catch((err) => {
    if (err.name === 'AbortError') throw new FriendlyError(`${name} is taking too long. Try again in a minute.`);
    throw new FriendlyError(`Couldn't reach ${name}. Check your internet.`, true);
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok) return data;
  console.warn('[Good Parts]', name, 'error', res.status, data.error);
  if (res.status === 401 || res.status === 403 || /api.?key/i.test(JSON.stringify(data.error || ''))) {
    throw new FriendlyError(`Your ${name} key isn't working. Paste a new one in the settings tab.`, false, true);
  }
  if (res.status === 429) throw new FriendlyError(`${name} is busy or your limit is used up. Try again later.`);
  if (res.status === 409) throw new FriendlyError('This copy of Good Parts is out of date. Ask for the new version.'); // Only the free Claude server sends 409.
  throw new FriendlyError(`${name} had a problem with this video. Try again in a minute.`, res.status >= 500);
}

// Each call takes { text, title, lines } (a transcript prompt and what it's made of) or, Gemini only,
// { videoId }, and returns the answer's JSON text. task: 'sponsors' asks for the sponsor reads instead of the parts.
async function callGemini({ text, videoId, task }, key, signal) {
  const parts = videoId
    ? [{ fileData: { fileUri: `https://www.youtube.com/watch?v=${videoId}` } }, { text: VIDEO_PROMPT }]
    : [{ text }];
  const schema = task === 'sponsors' ? SPONSOR_SCHEMA : SCHEMA;
  const data = await post('Gemini', 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent', { 'x-goog-api-key': key }, {
    contents: [{ parts }],
    // Low thinking answered in ~8 s instead of 20-60 s with the same picks in testing.
    generationConfig: { thinkingConfig: { thinkingLevel: 'low' }, responseMimeType: 'application/json', responseSchema: schema },
  }, signal);
  return (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
}

// Raw HTTP like the other two: the extension has no build step to bundle Anthropic's SDK.
// Low effort: ~21 s with the same picks as the default (~33 s).
async function callClaude({ text, title, lines, task }, key, signal) {
  const data = key
    ? await post('Claude', 'https://api.anthropic.com/v1/messages', {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true', // Anthropic only answers requests from a browser page with this.
    }, {
      model: 'claude-haiku-5-5',
      max_tokens: 16000,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: task === 'sponsors' ? SPONSOR_JSON_SCHEMA : JSON_SCHEMA } },
      messages: [{ role: 'user', content: text }],
    }, signal)
    : await post('Claude', FREE_CLAUDE, {}, { format: FORMAT, task, title, lines }, signal); // The server makes the same request.
  if (data.stop_reason === 'refusal') throw new FriendlyError('Claude declined this video. Try another AI in settings.');
  return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
}

// Normal reasoning: ~30 s, but its highlights stuck to "about a quarter"; low reasoning marked over half the video.
async function callOpenAI({ text, task }, key, signal) {
  const data = await post('GPT', 'https://api.openai.com/v1/responses', { authorization: `Bearer ${key}` }, {
    model: 'gpt-6-luna',
    input: text,
    text: { format: { type: 'json_schema', name: 'good_parts', schema: task === 'sponsors' ? SPONSOR_JSON_SCHEMA : JSON_SCHEMA, strict: true } },
  }, signal);
  const content = (data.output || []).filter((o) => o.type === 'message').flatMap((o) => o.content || []);
  if (content.some((c) => c.type === 'refusal')) throw new FriendlyError('GPT declined this video. Try another AI in settings.');
  return content.filter((c) => c.type === 'output_text').map((c) => c.text).join('');
}

// Which AI picks the parts (chosen in settings; Claude unless changed, since it needs no key). Only Gemini
// can watch a video itself, so videos without captions always go to Gemini.
const PROVIDERS = {
  gemini: { name: 'Gemini', keyName: 'apiKey', call: callGemini },
  claude: { name: 'Claude', keyName: 'claudeKey', call: callClaude, free: true },
  openai: { name: 'GPT', keyName: 'openaiKey', call: callOpenAI },
};

function readParts(answer, name) {
  const parts = cleanParts(answer.parts);
  if (!parts.length) throw new FriendlyError(`${name} didn't find any parts to keep.`);
  return parts;
}

// In testing about 1 in 7 Gemini video requests stalled or failed on Google's side, and some answers take 90+ s.
// So if the first request errors or is slow, send a backup and use whichever answers first.
// read turns the answer into what the caller needs: the parts unless told otherwise.
async function askAI(provider, request, key, read = readParts) {
  const { name, call } = PROVIDERS[provider];
  const controller = new AbortController();
  const giveUp = setTimeout(() => controller.abort(), GIVE_UP_AFTER);
  const ask = () => call(request, key, controller.signal).then((text) => read(JSON.parse(text), name));
  const first = ask();
  const backup = new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, BACKUP_AFTER);
    first.then(
      () => clearTimeout(timer),
      (err) => {
        clearTimeout(timer);
        if (err.retry) resolve();
        else reject(err);
      },
    );
  }).then(ask);
  try {
    return await Promise.any([first, backup]);
  } catch (err) {
    throw err.errors.find((e) => !e.retry) || err.errors[0];
  } finally {
    clearTimeout(giveUp);
    controller.abort(); // Cancel whichever request is still running.
  }
}

// Caption files the player downloaded, by video id. captions.js catches them from inside the page.
const captionFiles = {};
window.addEventListener('message', (e) => {
  const c = e.source === window && e.data?.goodPartsCaptions;
  if (c) captionFiles[c.v] = c.text;
});

// Turn the player's caption file into "[m:ss] words" lines of about `every` seconds each.
function captionLines(file, every) {
  let events;
  try {
    events = JSON.parse(file).events || [];
  } catch {
    return null;
  }
  const lines = [];
  let line;
  for (const ev of events) {
    const text = (ev.segs || []).map((s) => s.utf8).join('').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (!line || ev.tStartMs - line.start >= every * 1000) lines.push((line = { start: ev.tStartMs, words: [] }));
    line.words.push(text);
  }
  return lines.length ? lines.map((l) => `[${clock(l.start / 1000)}] ${l.words.join(' ')}`).join('\n') : null;
}

// If the player hasn't downloaded captions yet, switch them on out of sight so it does, then switch
// them back off. Lines are about 10 seconds each unless asked otherwise. Returns null when a video has no captions.
let reading = null; // { id, promise }: the parts and the sponsor check can both want captions, and only one may switch them.
async function readTranscript(videoId, every = 10) {
  if (!captionFiles[videoId] && reading?.id !== videoId) {
    const promise = switchCaptions(videoId);
    reading = { id: videoId, promise };
    promise.finally(() => { if (reading?.promise === promise) reading = null; });
  }
  if (reading?.id === videoId) await reading.promise;
  return captionFiles[videoId] ? captionLines(captionFiles[videoId], every) : null;
}

async function switchCaptions(videoId) {
  const cc = document.querySelector('#movie_player .ytp-subtitles-button');
  if (!cc) return;
  // Switched on before the video starts, captions never download, so wait for it to start (up to 10 s).
  for (let i = 0; i < 40 && !(video()?.currentTime > 0) && !captionFiles[videoId]; i++) await sleep(250);
  if (captionFiles[videoId]) return;
  const wasOn = cc.getAttribute('aria-pressed') === 'true';
  document.documentElement.classList.add('gp-reading');
  if (!wasOn) cc.click();
  for (let i = 0; i < 20 && !captionFiles[videoId]; i++) await sleep(250);
  if (!wasOn && cc.getAttribute('aria-pressed') === 'true') cc.click();
  document.documentElement.classList.remove('gp-reading');
}

// A background run stops without a word where a click would show something or send the whole video to
// Gemini (no captions); the viewer's own click then tries again out loud.
class QuietStop extends Error {}

const needKey = (message) => new FriendlyError(message, false, true);

// The AI picked in settings (Claude unless changed) and every saved key.
async function aiSettings() {
  const settings = await chrome.storage.local.get(['provider', 'apiKey', 'claudeKey', 'openaiKey']);
  return { settings, provider: PROVIDERS[settings.provider] ? settings.provider : 'claude' };
}

async function getParts(videoId, quiet) {
  const cacheKey = `parts4:${videoId}`;
  const cached = (await chrome.storage.local.get(cacheKey))[cacheKey];
  if (cached) return cached;
  const { settings, provider } = await aiSettings();
  const { name, keyName, free } = PROVIDERS[provider];
  if (!settings[keyName] && !free) throw needKey(`Add your ${name} key first.`);
  if (adShowing() && !quiet) toast('Good Parts will start after the ad.', GIVE_UP_AFTER);
  while (adShowing()) await sleep(500); // The player is busy with the ad's captions, not the video's.
  if (quiet && currentVideoId() !== videoId) throw new QuietStop('Moved on to another video.');
  // Captions are about 17 times cheaper than the video and come back in seconds.
  const transcript = await readTranscript(videoId);
  let parts;
  if (transcript) {
    const title = document.title.replace(/ - YouTube$/, '');
    parts = await askAI(provider, { text: transcriptPrompt(title, transcript), title, lines: transcript }, settings[keyName]);
  } else {
    if (quiet) throw new QuietStop('No captions.');
    if (!settings.apiKey) throw needKey('This video has no captions, and only Gemini can watch videos. Add a Gemini key.');
    toast('This video has no captions, so this can take a minute or two.', GIVE_UP_AFTER);
    parts = await askAI('gemini', { videoId }, settings.apiKey);
  }
  await chrome.storage.local.set({ [cacheKey]: parts });
  return parts;
}

// One load per video. A click while a background load runs waits for it, and retries out loud if it stopped quietly.
function loadParts(id, quiet = false) {
  const running = state.loading?.id === id ? state.loading : null;
  if (running && !(running.quiet && !quiet)) return running.promise;
  const first = running ? running.promise.catch((err) => (err instanceof QuietStop ? getParts(id, false) : Promise.reject(err))) : getParts(id, quiet);
  const promise = first.then((parts) => {
    if (currentVideoId() === id) {
      state.videoId = id;
      state.parts = parts;
      ensureButton();
    }
    return parts;
  });
  state.loading = { id, quiet, promise };
  promise.catch(() => {}).finally(() => { if (state.loading?.promise === promise) state.loading = null; });
  return promise;
}

// Once someone has watched 30 seconds of a long video (ads don't count), work out its good parts, so the
// button can show "Watch in 14 min" before they decide. Videos people click away from cost nothing.
let watching = { id: null, seconds: 0, at: null };
function noteWatching(v) {
  const id = currentVideoId();
  if (!id) return;
  if (watching.id !== id) watching = { id, seconds: 0, at: null };
  const step = watching.at === null ? 0 : v.currentTime - watching.at;
  if (step > 0 && step < 2) watching.seconds += step; // Bigger steps are the viewer jumping ahead.
  watching.at = v.currentTime;
  if (watching.seconds < WORK_OUT_AFTER || watching.started || !(v.duration >= LONG_VIDEO) || ready() || state.loading) return;
  watching.started = true;
  loadParts(id, true)
    .then(() => { if (!state.on && ready() && currentVideoId() === id) offer(); })
    .catch((err) => console.info('[Good Parts] not worked out in advance:', err.message));
}

// YouTube hides its controls while a video plays, so the button's "Watch in 14 min" may go unseen.
// Say it once in a message, with a button to start.
function offer() {
  toast(`Good Parts: ${watchMinutes(shorter)} min instead of ${Math.round(video().duration / 60)}`, 8000, {
    label: 'Watch',
    run: () => {
      if (state.on || !ready()) return;
      turnOn();
      ensureButton();
    },
  });
}

// ---------- Sponsors ----------

// Sponsors are skipped on every video, with Good Parts on or off, unless switched off in settings.
// null until the setting is read, so nothing is looked up for someone who switched it off.
let skipSponsors = null;
chrome.storage.local.get('skipSponsors').then((s) => { skipSponsors = s.skipSponsors !== false; });
chrome.storage.onChanged.addListener((changes) => { if (changes.skipSponsors) skipSponsors = changes.skipSponsors.newValue !== false; });

// The playing video's sponsor reads ({ start, end, watch }), empty until found. watch: the viewer chose to see it.
let sponsors = { id: null, list: [] };

// Overlapping or back-to-back stretches become one, so each sponsor is one skip and one message.
function joinSponsors(list) {
  const out = [];
  for (const s of list.filter((s) => s.end > s.start).sort((a, b) => a.start - b.start)) {
    const last = out[out.length - 1];
    if (last && s.start <= last.end + 1) last.end = Math.max(last.end, s.end);
    else out.push({ start: s.start, end: s.end });
  }
  return out;
}

const readSponsors = (answer) => joinSponsors(answer.sponsors.map((s) => ({ start: toSeconds(s.start), end: toSeconds(s.end) })));

// Sponsor times viewers marked on SponsorBlock (sponsor.ajay.app). It's asked for every video whose hashed id
// starts with the same 4 characters, so it never learns which one is playing. No answer counts as nothing marked.
async function sponsorBlock(videoId) {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(videoId)));
  const prefix = [...hash.slice(0, 2)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const res = await fetch(`https://sponsor.ajay.app/api/skipSegments/${prefix}`).catch(() => null);
  if (!res?.ok) return []; // 404: nothing marked.
  const marked = (await res.json()).find((v) => v.videoID === videoId)?.segments || [];
  return joinSponsors(marked.map((s) => ({ start: s.segment[0], end: s.segment[1] })));
}

// SponsorBlock first: instant and free. Videos it hasn't marked yet (often new or small ones) fall back to
// the captions: if they mention a sponsor, the AI finds where each read starts and ends.
async function findSponsors(videoId) {
  const marked = await sponsorBlock(videoId);
  if (marked.length) return marked;
  const cacheKey = `sponsors1:${videoId}`;
  const cached = (await chrome.storage.local.get(cacheKey))[cacheKey];
  if (cached) return cached;
  const lines = await readTranscript(videoId, 3); // Short lines, so a skip starts and ends close to the read.
  if (!lines) return [];
  let found = [];
  if (SPONSOR_WORDS.test(lines)) {
    const { settings, provider } = await aiSettings();
    const { keyName, free } = PROVIDERS[provider];
    if (!settings[keyName] && !free) return [];
    const title = document.title.replace(/ - YouTube$/, '');
    found = await askAI(provider, { task: 'sponsors', text: sponsorPrompt(title, lines), title, lines }, settings[keyName], readSponsors);
  }
  await chrome.storage.local.set({ [cacheKey]: found });
  return found;
}

// Called as the video plays (never during an ad): looks up each new video's sponsors once.
function loadSponsors() {
  const id = currentVideoId();
  if (!skipSponsors || !id || sponsors.id === id) return;
  const mine = (sponsors = { id, list: [] });
  findSponsors(id)
    .then((list) => { mine.list = list; })
    .catch((err) => console.info('[Good Parts] sponsors not found:', err.message));
}

// The last half second counts as past the end, so landing a hair short of it can't skip again.
const sponsorAt = (t) => sponsors.list.find((s) => t >= s.start && t < s.end - 0.5);

function skipSponsor(v) {
  const s = skipSponsors && sponsors.id === currentVideoId() && sponsorAt(v.currentTime);
  if (!s || s.watch) return;
  jump(v, s.end);
  toast(`Skipped a sponsor (${howLong(s.end - s.start)})`, 4000, { label: 'Undo', run: () => watchSponsor(s) });
}

function watchSponsor(s) {
  s.watch = true;
  video().currentTime = s.start;
}

// ---------- UI ----------

const ready = () => !!state.parts && state.videoId === currentVideoId();

// Minutes to watch with the rest at 2x (or 1.5x the viewer's own speed), or, short, with the rest at 3x.
function watchMinutes(short) {
  const base = state.on ? state.baseRate : video()?.playbackRate || 1;
  const time = (kind) => state.parts.filter((p) => p.kind === kind).reduce((sum, p) => sum + (p.end - p.start), 0);
  return Math.round((time('highlight') / base + time('play') / fastSpeed(base, short)) / 60);
}

function ensureButton() {
  const right = document.querySelector('#movie_player .ytp-chrome-controls .ytp-right-controls');
  if (!right) return;
  let btn = right.parentElement.querySelector(':scope > .gp-button');
  let alt = right.parentElement.querySelector(':scope > .gp-length');
  if (!btn) {
    btn = document.createElement('button');
    btn.className = 'gp-button';
    btn.addEventListener('click', onButtonClick);
    right.before(btn); // Its own pill; YouTube's control pills have fixed widths and clip extra buttons.
  }
  if (!alt) {
    alt = document.createElement('button');
    alt.className = 'gp-length';
    alt.addEventListener('click', onLengthClick);
    right.before(alt);
  }
  btn.hidden = !currentVideoId();
  // On, both buttons name a speed for the rest and a length, so they read as two choices:
  // "Good parts: 2x · 12 min" and "or 3x · 9 min".
  const base = state.on ? state.baseRate : video()?.playbackRate || 1;
  const label = state.busy ? 'Finding good parts…'
    : state.on ? `Good parts: ${fastSpeed(base)}x · ${watchMinutes(shorter)} min`
    : ready() ? `Watch in ${watchMinutes(shorter)} min`
    : 'Good parts';
  if (btn.textContent !== label) btn.textContent = label;
  btn.classList.toggle('gp-on', state.on);
  btn.classList.toggle('gp-ready', !state.on && !state.busy && ready());
  btn.title = state.on ? 'Back to the full video' : 'Watch the best parts, speed through the rest';
  // The other length, one click away. Hidden when both come out the same (a viewer already at 3x).
  const other = !btn.hidden && !state.busy && ready() ? watchMinutes(!shorter) : null;
  alt.hidden = other === null || other === watchMinutes(shorter);
  const altLabel = `or ${fastSpeed(base, !shorter)}x · ${other} min`;
  if (!alt.hidden && alt.textContent !== altLabel) alt.textContent = altLabel;
  alt.title = `The rest at ${fastSpeed(base, !shorter)}x`;
}

let toastTimer;
let toastFor; // The video a message is about, so switching videos can clear it.
// action: an optional { label, run } button, such as Undo after a skip.
function toast(text, ms = 3000, action) {
  const host = player();
  if (!host) return;
  toastFor = currentVideoId();
  let el = host.querySelector('.gp-toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'gp-toast';
    host.appendChild(el);
  }
  el.textContent = text;
  if (action) {
    const b = document.createElement('button');
    b.className = 'gp-toast-action';
    b.textContent = action.label;
    // Clicks on the player would also pause or play the video.
    for (const type of ['mousedown', 'mouseup', 'pointerdown', 'pointerup']) b.addEventListener(type, (e) => e.stopPropagation());
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      el.classList.remove('gp-show');
      action.run();
    });
    el.appendChild(b);
  }
  el.classList.add('gp-show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('gp-show'), ms);
}

function drawMarkers() {
  const v = video();
  const bar = document.querySelector('#movie_player .ytp-progress-bar');
  if (!v || !bar || !v.duration || adShowing()) return;
  if (state.markersFor === v.duration && bar.querySelector('.gp-markers')) return;
  removeMarkers();
  const wrap = document.createElement('div');
  wrap.className = 'gp-markers';
  for (const p of state.parts) {
    const m = document.createElement('div');
    m.className = `gp-marker gp-${p.kind}`;
    m.style.left = `${(p.start / v.duration) * 100}%`;
    m.style.width = `${((Math.min(p.end, v.duration) - p.start) / v.duration) * 100}%`;
    wrap.appendChild(m);
  }
  bar.appendChild(wrap);
  state.markersFor = v.duration;
}

function removeMarkers() {
  document.querySelectorAll('.gp-markers').forEach((el) => el.remove());
  state.markersFor = null;
}

// ---------- Playing the good parts ----------

function partAt(t) {
  return state.parts.find((p) => t >= p.start - 0.5 && t < p.end);
}

// The plays between highlights go at 2x (3x felt too fast), or the shorter length's 3x (the small button next
// to Good Parts; that choice is remembered). Never slower than the viewer's own speed.
// (The old settings checkbox saved "faster"; it's ignored, so everyone starts at 2x.)
let shorter = false;
chrome.storage.local.get('shorter').then((s) => { shorter = !!s.shorter; });
chrome.storage.onChanged.addListener((changes) => { if (changes.shorter) shorter = !!changes.shorter.newValue; });
function fastSpeed(base, short = shorter) {
  return Math.max(base, short ? 3 : 2);
}

function setSpeed(rate) {
  const v = video();
  if (v && v.playbackRate !== rate) v.playbackRate = rate;
}

const howLong = (sec) => (sec < 90 ? `${Math.round(sec)} seconds` : `${Math.round(sec / 60)} min`);

// Good Parts' own jumps, and the viewer's last click, tap or key press outside an ad (so Skip Ad doesn't count).
// Together they tell onSeeking which moves were the viewer's, not Good Parts' or YouTube's (such as going back
// to the video after an ad).
let ownSeek = false;
let lastInput = 0;
for (const type of ['pointerdown', 'pointerup', 'keydown']) {
  window.addEventListener(type, () => { if (!adShowing()) lastInput = Date.now(); }, true);
}

function jump(v, t) {
  ownSeek = true;
  v.currentTime = t;
}

// Skip downtime, speed through plays, and play highlights at the viewer's own speed. Speed only changes
// when a new part starts, so a speed the viewer picks mid-part sticks until the next one.
function follow() {
  const v = video();
  const part = partAt(v.currentTime);
  if (!part) {
    // A skipped stretch the viewer chose to watch plays at their own speed until the next part.
    if (state.openGap && v.currentTime < state.openGap.end) {
      if (state.current !== state.openGap) {
        state.current = state.openGap;
        setSpeed(state.baseRate);
        ensureButton();
      }
      return;
    }
    state.openGap = null;
    const next = state.parts.find((p) => p.start > v.currentTime);
    if (next) {
      const from = v.currentTime;
      jump(v, next.start);
      // Land in the next part here, so its own message can't replace this one and its Undo button.
      state.current = next;
      setSpeed(next.kind === 'play' ? fastSpeed(state.baseRate) : state.baseRate);
      ensureButton();
      toast(`Skipped ${howLong(next.start - from)}`, 4000, { label: 'Undo', run: () => watchSkipped(from, next.start) });
    } else {
      v.pause();
      turnOff();
      toast("That's everything worth watching.", 4000);
    }
    return;
  }
  state.openGap = null;
  if (part === state.current) return;
  state.current = part;
  const fast = part.kind === 'play';
  setSpeed(fast ? fastSpeed(state.baseRate) : state.baseRate);
  ensureButton();
  if (!fast) toast(`Highlight: ${part.label}`);
}

function watchSkipped(start, end) {
  if (!state.on) return;
  state.openGap = { start, end };
  video().currentTime = start;
  follow();
}

// The viewer moved the video (dragged the bar, pressed an arrow key, clicked a timestamp). If they landed
// in a skipped stretch or a sponsor, they want to see it, so it plays instead of being skipped again.
function onSeeking(e) {
  const v = e.target;
  if (v !== video()) return;
  const own = ownSeek;
  ownSeek = false;
  if (own || adShowing() || Date.now() - lastInput > 1000) return;
  const t = v.currentTime;
  const s = sponsorAt(t);
  if (s) s.watch = true;
  if (!state.on) return;
  const next = state.parts.find((p) => p.start > t);
  state.openGap = partAt(t) ? null : { start: t, end: next ? next.start : v.duration };
}

function onTimeUpdate(e) {
  const v = e.target;
  if (v !== video()) return;
  if (adShowing()) {
    // Ads play at their own speed. Pick the right speed again once the video is back.
    if (state.on && state.current) {
      setSpeed(state.baseRate);
      state.current = null;
      ensureButton();
    }
    return;
  }
  loadSponsors();
  if (state.on) {
    drawMarkers();
    follow();
  } else {
    noteWatching(v);
  }
  skipSponsor(v);
}

function summary() {
  const v = video();
  return `About ${watchMinutes(shorter)} min instead of ${Math.round(v.duration / 60)}. Best parts play as usual, the rest at ${fastSpeed(state.baseRate)}x, filler skipped.`;
}

function turnOn() {
  state.on = true;
  state.current = null;
  state.openGap = null;
  const v = video();
  state.baseRate = v.playbackRate;
  if (adShowing()) {
    toast(`About ${watchMinutes(shorter)} min to watch. Starting after the ad.`, 4000);
    return; // onTimeUpdate takes over once the ad ends.
  }
  // Start inside a part, so the next part's own message can't replace the summary below a moment later.
  if (!partAt(v.currentTime)) jump(v, (state.parts.find((p) => p.start > v.currentTime) || state.parts[0]).start);
  follow();
  drawMarkers();
  v.play().catch(() => {});
  toast(summary(), 5000);
}

function turnOff() {
  if (state.on) setSpeed(state.baseRate);
  state.on = false;
  state.current = null;
  state.openGap = null;
  removeMarkers();
  ensureButton();
}

async function onButtonClick(e) {
  e.stopPropagation();
  if (state.busy) return;
  if (state.on) {
    turnOff();
    return;
  }
  const id = currentVideoId();
  if (!id) return;
  if (!ready()) {
    state.busy = true;
    ensureButton();
    try {
      await loadParts(id);
      if (currentVideoId() !== id) return; // Moved on to another video while waiting.
    } catch (err) {
      console.warn('[Good Parts]', err);
      if (err.settings) chrome.runtime.sendMessage('openOptions');
      toast(err instanceof FriendlyError ? err.message : 'Something went wrong. Refresh the page and try again.', 5000);
      return;
    } finally {
      state.busy = false;
      ensureButton();
    }
  }
  turnOn();
  ensureButton();
}

// The small button: switch to the other length (and start, if Good Parts is off). The choice is remembered.
function onLengthClick(e) {
  e.stopPropagation();
  if (state.busy || !ready()) return;
  shorter = !shorter;
  chrome.storage.local.set({ shorter });
  if (!state.on) {
    turnOn();
  } else {
    state.current = null; // Re-pick the speed for the part playing now.
    follow();
    toast(summary(), 4000);
  }
  ensureButton();
}

function onNavigate() {
  // YouTube also fires this once on a fresh page load, so only clear messages about another video.
  if (currentVideoId() !== toastFor) player()?.querySelector('.gp-toast')?.classList.remove('gp-show');
  if (currentVideoId() !== state.videoId) {
    turnOff();
    state.parts = null;
    state.videoId = null;
  }
  ensureButton();
}

document.addEventListener('timeupdate', onTimeUpdate, true); // Media events don't bubble, but capture sees them.
document.addEventListener('seeking', onSeeking, true);
document.addEventListener('yt-navigate-start', turnOff); // Stop before the next video starts playing.
document.addEventListener('yt-navigate-finish', onNavigate);
setInterval(ensureButton, 1000); // YouTube rebuilds its player controls at will.
ensureButton();
