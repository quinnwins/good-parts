const LEAD_IN = 2; // The AI's starts can land mid-sentence, so begin each part a moment early.
const BACKUP_AFTER = 75000;
const GIVE_UP_AFTER = 180000;
// Without a Claude key, Claude goes through the Good Parts server (server/worker.js), so friends' copies need no key.
const FREE_CLAUDE = 'https://good-parts.quinnwins.workers.dev';

const HIGHLIGHTS = 0.25; // Share of the video that plays at the viewer's own speed.

let state = { videoId: null, parts: null, on: false, busy: false, markersFor: null, baseRate: 1, current: null };

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
  const parts = raw
    .map((p) => ({ start: Math.max(0, toSeconds(p.start) - LEAD_IN), end: toSeconds(p.end), score: p.score, label: p.label }))
    .filter((p) => p.end > p.start)
    .sort((a, b) => a.start - b.start);
  // Asked for "about a quarter", the AI marked 42-61% of a video as highlights. So it scores each part, and
  // the best-scored parts become highlights until they fill a quarter of the video. The best one always does.
  const budget = HIGHLIGHTS * Math.max(0, ...parts.map((p) => p.end));
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
class FriendlyError extends Error {
  constructor(message, retry = false) {
    super(message);
    this.retry = retry;
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
    chrome.runtime.sendMessage('openOptions');
    throw new FriendlyError(`Your ${name} key isn't working. Paste a new one in the settings tab.`);
  }
  if (res.status === 429) throw new FriendlyError(`${name} is busy or your limit is used up. Try again later.`);
  if (res.status === 409) throw new FriendlyError('This copy of Good Parts is out of date. Ask for the new version.'); // Only the free Claude server sends 409.
  throw new FriendlyError(`${name} had a problem with this video. Try again in a minute.`, res.status >= 500);
}

// Each call takes { text, title, lines } (a transcript prompt and what it's made of) or, Gemini only,
// { videoId }, and returns the answer's JSON text.
async function callGemini({ text, videoId }, key, signal) {
  const parts = videoId
    ? [{ fileData: { fileUri: `https://www.youtube.com/watch?v=${videoId}` } }, { text: VIDEO_PROMPT }]
    : [{ text }];
  const data = await post('Gemini', 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent', { 'x-goog-api-key': key }, {
    contents: [{ parts }],
    // Low thinking answered in ~8 s instead of 20-60 s with the same picks in testing.
    generationConfig: { thinkingConfig: { thinkingLevel: 'low' }, responseMimeType: 'application/json', responseSchema: SCHEMA },
  }, signal);
  return (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
}

// Raw HTTP like the other two: the extension has no build step to bundle Anthropic's SDK.
// Low effort: ~21 s with the same picks as the default (~33 s).
async function callClaude({ text, title, lines }, key, signal) {
  const data = key
    ? await post('Claude', 'https://api.anthropic.com/v1/messages', {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true', // Anthropic only answers requests from a browser page with this.
    }, {
      model: 'claude-haiku-5-5',
      max_tokens: 16000,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: JSON_SCHEMA } },
      messages: [{ role: 'user', content: text }],
    }, signal)
    : await post('Claude', FREE_CLAUDE, {}, { format: FORMAT, title, lines }, signal); // The server makes the same request.
  if (data.stop_reason === 'refusal') throw new FriendlyError('Claude declined this video. Try another AI in settings.');
  return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
}

// Normal reasoning: ~30 s, but its highlights stuck to "about a quarter"; low reasoning marked over half the video.
async function callOpenAI({ text }, key, signal) {
  const data = await post('GPT', 'https://api.openai.com/v1/responses', { authorization: `Bearer ${key}` }, {
    model: 'gpt-6-luna',
    input: text,
    text: { format: { type: 'json_schema', name: 'good_parts', schema: JSON_SCHEMA, strict: true } },
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

// In testing about 1 in 7 Gemini video requests stalled or failed on Google's side, and some answers take 90+ s.
// So if the first request errors or is slow, send a backup and use whichever answers first.
async function askAI(provider, request, key) {
  const { name, call } = PROVIDERS[provider];
  const controller = new AbortController();
  const giveUp = setTimeout(() => controller.abort(), GIVE_UP_AFTER);
  const ask = () =>
    call(request, key, controller.signal).then((text) => {
      const parts = cleanParts(JSON.parse(text).parts);
      if (!parts.length) throw new FriendlyError(`${name} didn't find any parts to keep.`);
      return parts;
    });
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

// Turn the player's caption file into "[m:ss] words" lines of about 10 seconds each.
function captionLines(file) {
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
    if (!line || ev.tStartMs - line.start >= 10000) lines.push((line = { start: ev.tStartMs, words: [] }));
    line.words.push(text);
  }
  return lines.length ? lines.map((l) => `[${clock(l.start / 1000)}] ${l.words.join(' ')}`).join('\n') : null;
}

// If the player hasn't downloaded captions yet, switch them on out of sight so it does, then switch
// them back off. Returns null when a video has no captions.
async function readTranscript(videoId) {
  const cc = document.querySelector('#movie_player .ytp-subtitles-button');
  if (!captionFiles[videoId] && cc) {
    const wasOn = cc.getAttribute('aria-pressed') === 'true';
    document.documentElement.classList.add('gp-reading');
    if (!wasOn) cc.click();
    for (let i = 0; i < 20 && !captionFiles[videoId]; i++) await sleep(250);
    if (!wasOn && cc.getAttribute('aria-pressed') === 'true') cc.click();
    document.documentElement.classList.remove('gp-reading');
  }
  return captionFiles[videoId] ? captionLines(captionFiles[videoId]) : null;
}

function needKey(message) {
  chrome.runtime.sendMessage('openOptions');
  return new FriendlyError(message);
}

async function getParts(videoId) {
  const cacheKey = `parts3:${videoId}`;
  const cached = (await chrome.storage.local.get(cacheKey))[cacheKey];
  if (cached) return cached;
  const settings = await chrome.storage.local.get(['provider', 'apiKey', 'claudeKey', 'openaiKey']);
  const provider = PROVIDERS[settings.provider] ? settings.provider : 'claude';
  const { name, keyName, free } = PROVIDERS[provider];
  if (!settings[keyName] && !free) throw needKey(`Add your ${name} key first.`);
  if (adShowing()) toast('Good Parts will start after the ad.', GIVE_UP_AFTER);
  while (adShowing()) await sleep(500); // The player is busy with the ad's captions, not the video's.
  // Captions are about 17 times cheaper than the video and come back in seconds.
  const transcript = await readTranscript(videoId);
  let parts;
  if (transcript) {
    const title = document.title.replace(/ - YouTube$/, '');
    parts = await askAI(provider, { text: transcriptPrompt(title, transcript), title, lines: transcript }, settings[keyName]);
  } else {
    if (!settings.apiKey) throw needKey('This video has no captions, and only Gemini can watch videos. Add a Gemini key.');
    toast('This video has no captions, so this can take a minute or two.', GIVE_UP_AFTER);
    parts = await askAI('gemini', { videoId }, settings.apiKey);
  }
  await chrome.storage.local.set({ [cacheKey]: parts });
  return parts;
}

// ---------- UI ----------

function ensureButton() {
  const right = document.querySelector('#movie_player .ytp-chrome-controls .ytp-right-controls');
  if (!right) return;
  let btn = right.parentElement.querySelector(':scope > .gp-button');
  if (!btn) {
    btn = document.createElement('button');
    btn.className = 'gp-button';
    btn.addEventListener('click', onButtonClick);
    right.before(btn); // Its own pill; YouTube's control pills have fixed widths and clip extra buttons.
  }
  btn.hidden = !currentVideoId();
  // While a part is sped up, the button shows the speed, so the jump doesn't look like a glitch.
  const fast = state.on && state.current?.kind === 'play';
  const label = state.busy ? 'Finding good parts…' : fast ? `Good parts: ${video().playbackRate}x` : state.on ? 'Good parts: on' : 'Good parts';
  if (btn.textContent !== label) btn.textContent = label;
  btn.classList.toggle('gp-on', state.on);
  btn.title = state.on ? 'Back to the full video' : 'Watch the best parts, speed through the rest';
}

let toastTimer;
let toastFor; // The video a message is about, so switching videos can clear it.
function toast(text, ms = 3000) {
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

// The plays between highlights go 1.5 times the viewer's own speed, kept between 2x and 3x (faster
// is hard to follow) and never slower than the viewer's own speed. Quarter steps keep the label tidy.
// "Play the rest at 3x" in settings makes them 3x.
let faster = false;
chrome.storage.local.get('faster').then((s) => { faster = !!s.faster; });
chrome.storage.onChanged.addListener((changes) => { if (changes.faster) faster = !!changes.faster.newValue; });
function fastSpeed(base) {
  if (faster) return Math.max(base, 3);
  return Math.max(base, Math.min(3, Math.max(2, Math.round(base * 1.5 * 4) / 4)));
}

function setSpeed(rate) {
  const v = video();
  if (v && v.playbackRate !== rate) v.playbackRate = rate;
}

// Skip downtime, speed through plays, and play highlights at the viewer's own speed. Speed only changes
// when a new part starts, so a speed the viewer picks mid-part sticks until the next one.
function follow() {
  const v = video();
  const part = partAt(v.currentTime);
  if (!part) {
    const next = state.parts.find((p) => p.start > v.currentTime);
    if (next) {
      v.currentTime = next.start;
      toast(`Skipping to ${clock(next.start)}: ${next.label}`);
    } else {
      v.pause();
      turnOff();
      toast("That's everything worth watching.", 4000);
    }
    return;
  }
  if (part === state.current) return;
  state.current = part;
  const fast = part.kind === 'play';
  setSpeed(fast ? fastSpeed(state.baseRate) : state.baseRate);
  ensureButton();
  if (!fast) toast(`Highlight: ${part.label}`);
}

function onTimeUpdate(e) {
  if (!state.on || e.target !== video()) return;
  if (adShowing()) {
    // Ads play at their own speed. Pick the right speed again once the video is back.
    if (state.current) {
      setSpeed(state.baseRate);
      state.current = null;
      ensureButton();
    }
    return;
  }
  drawMarkers();
  follow();
}

function turnOn() {
  state.on = true;
  state.current = null;
  const v = video();
  state.baseRate = v.playbackRate;
  const fast = fastSpeed(state.baseRate);
  const time = (kind) => state.parts.filter((p) => p.kind === kind).reduce((sum, p) => sum + (p.end - p.start), 0);
  const watch = Math.round((time('highlight') / state.baseRate + time('play') / fast) / 60);
  if (adShowing()) {
    toast(`About ${watch} min to watch. Starting after the ad.`, 4000);
    return; // onTimeUpdate takes over once the ad ends.
  }
  // Start inside a part, so the next part's own message can't replace the summary below a moment later.
  if (!partAt(v.currentTime)) v.currentTime = (state.parts.find((p) => p.start > v.currentTime) || state.parts[0]).start;
  follow();
  drawMarkers();
  v.play().catch(() => {});
  toast(`About ${watch} min instead of ${Math.round(v.duration / 60)}. Best parts play as usual, the rest at ${fast}x, filler skipped.`, 5000);
}

function turnOff() {
  if (state.on) setSpeed(state.baseRate);
  state.on = false;
  state.current = null;
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
  if (!state.parts || state.videoId !== id) {
    state.busy = true;
    ensureButton();
    try {
      const parts = await getParts(id);
      if (currentVideoId() !== id) return; // Moved on to another video while waiting.
      state.videoId = id;
      state.parts = parts;
    } catch (err) {
      console.warn('[Good Parts]', err);
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
document.addEventListener('yt-navigate-start', turnOff); // Stop before the next video starts playing.
document.addEventListener('yt-navigate-finish', onNavigate);
setInterval(ensureButton, 1000); // YouTube rebuilds its player controls at will.
ensureButton();
