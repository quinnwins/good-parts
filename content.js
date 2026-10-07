const MODEL = 'gemini-3.8-flash';
const LEAD_IN = 2; // Gemini's starts can land mid-sentence, so begin each part a moment early.
const BACKUP_AFTER = 75000;
const GIVE_UP_AFTER = 180000;
const FAST = 2; // Speed for the plays between highlights.

// Like a condensed football game with the best plays marked: highlights play normally, the other
// plays go by at 2x, and the downtime is skipped.
const EDIT = `Edit it like a condensed football game with the best plays marked: nothing of substance is lost, the downtime is cut, and the best moments stand out.
List every stretch worth keeping, in time order, and mark each one:
- highlight: the best stuff, the main points, key arguments, demos, surprising facts, and the conclusion. About a quarter of the video.
- play: everything else with substance, such as smaller points, examples, numbers, and reasons. Never drop one because it seems minor.
Leave out the downtime: sponsor reads (all of them, from the first sentence to the last), channel plugs, "like and subscribe", greetings and sign-offs, waiting for something to load, filler, rambling, repeating a point already made, and tangents that go nowhere.
Stretches must not overlap.`;

const VIDEO_PROMPT = `Watch this YouTube video. ${EDIT}
Each stretch must be a complete thought: start just before it begins and end after it lands, never mid-sentence.
Write timestamps as M:SS or H:MM:SS using the video's own clock.`;

const transcriptPrompt = (title, lines) => `Here is the transcript of the YouTube video "${title}". Each line starts with its timestamp.
${EDIT}
Each stretch must be a complete thought: start at the line where it begins, and end at the timestamp of the first line after it.

${lines}`;

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    parts: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          start: { type: 'STRING' },
          end: { type: 'STRING' },
          kind: { type: 'STRING', enum: ['highlight', 'play'] },
          label: { type: 'STRING', description: 'A few plain words saying what this part covers' },
        },
        required: ['start', 'end', 'kind', 'label'],
      },
    },
  },
  required: ['parts'],
};

let state = { videoId: null, parts: null, on: false, busy: false, markersFor: null, baseRate: 1, current: null };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const player = () => document.querySelector('#movie_player');
const video = () => document.querySelector('#movie_player video');
const adShowing = () => player()?.classList.contains('ad-showing');

function currentVideoId() {
  return location.pathname === '/watch' ? new URLSearchParams(location.search).get('v') : null;
}

function toSeconds(ts) {
  // Gemini often copies the transcript's brackets, e.g. "[3:12]".
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

// Sort, add the lead-in, and tidy the edges: merge same-kind parts that overlap or sit a blink apart
// (a 1-second skip is just jarring), and never let two parts overlap.
function cleanParts(raw) {
  const parts = raw
    .map((p) => ({ start: Math.max(0, toSeconds(p.start) - LEAD_IN), end: toSeconds(p.end), kind: p.kind, label: p.label }))
    .filter((p) => p.end > p.start)
    .sort((a, b) => a.start - b.start);
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

// `retry` marks hiccups on Google's side that are worth asking again about.
class FriendlyError extends Error {
  constructor(message, retry = false) {
    super(message);
    this.retry = retry;
  }
}

async function callGemini(content, apiKey, signal) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    signal,
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [{ parts: content }],
      // Low thinking answered in ~8 s instead of 20-60 s with the same picks in testing.
      generationConfig: { thinkingConfig: { thinkingLevel: 'low' }, responseMimeType: 'application/json', responseSchema: SCHEMA },
    }),
  }).catch((err) => {
    if (err.name === 'AbortError') throw new FriendlyError('Gemini is taking too long. Try again in a minute.');
    throw new FriendlyError("Couldn't reach Gemini. Check your internet.", true);
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.warn('[Good Parts] Gemini error', res.status, data.error);
    const msg = data.error?.message || '';
    if (/api key/i.test(msg)) throw new FriendlyError("Your Gemini key isn't working.");
    if (res.status === 429) throw new FriendlyError('Gemini is busy or out of free uses for today. Try again later.');
    throw new FriendlyError("Gemini couldn't watch this video.", res.status >= 500);
  }
  const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
  const parts = cleanParts(JSON.parse(text).parts);
  if (!parts.length) throw new FriendlyError("Gemini didn't find any parts to keep.");
  return parts;
}

// Most answers take 15-60 s, but in testing about 1 in 7 requests stalled or failed on Google's side.
// So if the first request errors or is slow, send a backup and use whichever answers first.
async function askGemini(content) {
  const { apiKey } = await chrome.storage.local.get('apiKey');
  if (!apiKey) {
    chrome.runtime.sendMessage('openOptions');
    throw new FriendlyError('Add your Gemini key first.');
  }
  const controller = new AbortController();
  const giveUp = setTimeout(() => controller.abort(), GIVE_UP_AFTER);
  const ask = () => callGemini(content, apiKey, controller.signal);
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

async function getParts(videoId) {
  const cacheKey = `parts2:${videoId}`;
  const cached = (await chrome.storage.local.get(cacheKey))[cacheKey];
  if (cached) return cached;
  if (adShowing()) toast('Good Parts will start after the ad.', GIVE_UP_AFTER);
  while (adShowing()) await sleep(500); // The player is busy with the ad's captions, not the video's.
  // Captions are about 17 times cheaper than the video and come back in seconds.
  const transcript = await readTranscript(videoId);
  const title = document.title.replace(/ - YouTube$/, '');
  const content = transcript
    ? [{ text: transcriptPrompt(title, transcript) }]
    : [{ fileData: { fileUri: `https://www.youtube.com/watch?v=${videoId}` } }, { text: VIDEO_PROMPT }];
  toast(transcript ? 'Gemini is reading the transcript…' : 'Gemini is watching the video. This can take a minute or two.', GIVE_UP_AFTER);
  const parts = await askGemini(content);
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
  const label = state.busy ? 'Finding good parts…' : state.on ? 'Good parts: on' : 'Good parts';
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
  setSpeed(fast ? Math.max(FAST, state.baseRate) : state.baseRate);
  player().classList.toggle('gp-fast', fast);
  if (!fast) toast(`Highlight: ${part.label}`);
}

function onTimeUpdate(e) {
  if (!state.on || e.target !== video()) return;
  if (adShowing()) {
    // Ads play at their own speed. Pick the right speed again once the video is back.
    if (state.current) {
      setSpeed(state.baseRate);
      state.current = null;
      player().classList.remove('gp-fast');
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
  const time = (kind) => state.parts.filter((p) => p.kind === kind).reduce((sum, p) => sum + (p.end - p.start), 0);
  const watch = Math.round((time('highlight') / state.baseRate + time('play') / Math.max(FAST, state.baseRate)) / 60);
  if (adShowing()) {
    toast(`About ${watch} min to watch. Starting after the ad.`, 4000);
    return; // onTimeUpdate takes over once the ad ends.
  }
  if (!partAt(v.currentTime) && !state.parts.some((p) => p.start > v.currentTime)) v.currentTime = state.parts[0].start;
  follow();
  drawMarkers();
  v.play().catch(() => {});
  toast(`About ${watch} min instead of ${Math.round(v.duration / 60)}. Best parts at normal speed, the rest at 2x, filler skipped.`, 5000);
}

function turnOff() {
  if (state.on) setSpeed(state.baseRate);
  state.on = false;
  state.current = null;
  player()?.classList.remove('gp-fast');
  removeMarkers();
  ensureButton();
}

async function onButtonClick(e) {
  e.stopPropagation();
  if (state.busy) return;
  if (state.on) {
    turnOff();
    toast('Back to the full video.');
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
      toast(err instanceof FriendlyError ? err.message : 'Something went wrong. Try again.', 5000);
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
