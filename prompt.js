// What Good Parts asks the AI and the answer format it expects. The extension loads this before content.js,
// and the free Claude server (server/worker.js) builds from it too, so both always ask the same thing.
// Change FORMAT whenever the answer format changes: the server then tells copies built for the old format
// to update, instead of sending them answers they can't read.
const FORMAT = 2;

// Like a condensed football game with the best plays marked: highlights play normally, the other
// plays go by faster, and the downtime is skipped. The AI scores each part; cleanParts picks the highlights.
const EDIT = `Edit it like a condensed football game with the best plays marked: nothing of substance is lost, the downtime is cut, and the best moments stand out.
List every stretch worth keeping, in time order, one point or topic per stretch, and score how good each one is from 1 to 10:
- 8 to 10: the best stuff, such as the main points, key arguments, demos, surprising facts, and the conclusion.
- 1 to 7: everything else with substance, such as smaller points, examples, numbers, and reasons. Never drop one because it seems minor.
Leave out the downtime: sponsor reads (all of them, from the first sentence to the last), channel plugs, "like and subscribe", greetings and sign-offs, waiting for something to load, filler, rambling, repeating a point already made, and tangents that go nowhere.
Stretches must not overlap.`;

const VIDEO_PROMPT = `Watch this YouTube video. ${EDIT}
Each stretch must be a complete thought: start just before it begins and end after it lands, never mid-sentence.
Write timestamps as M:SS or H:MM:SS using the video's own clock.`;

const transcriptPrompt = (title, lines) => `Here is the transcript of the YouTube video "${title}". Each line starts with its timestamp.
${EDIT}
Each stretch must be a complete thought: start at the line where it begins, and end at the timestamp of the first line after it.

${lines}`;

// Only for videos SponsorBlock hasn't marked yet, whose captions mention a sponsor (see findSponsors in content.js).
const sponsorPrompt = (title, lines) => `Here is the transcript of the YouTube video "${title}". Each line starts with its timestamp.
List every sponsor read: a stretch where the creator promotes a product or service for a company that paid for it, such as "this video is sponsored by", "thanks to ... for sponsoring", or a brand's discount code or link.
Each one runs from its first sentence to its last, including the lead-in ("but first, a word from...") and the handoff back to the video. Start at the line where it begins, and end at the timestamp of the first line after it.
Leave out the creator's own merch, courses, and channel plugs, and brands that are simply what the video is about. If there are no sponsor reads, return an empty list.

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
          label: { type: 'STRING', description: 'A few plain words saying what this part covers' },
          score: { type: 'INTEGER', description: 'How good this part is, from 1 to 10' },
        },
        required: ['start', 'end', 'label', 'score'],
      },
    },
  },
  required: ['parts'],
};

// The same answer format for Claude and GPT (Gemini's API spells its schema differently, above).
const JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['parts'],
  properties: {
    parts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['start', 'end', 'label', 'score'],
        properties: {
          start: { type: 'string' },
          end: { type: 'string' },
          label: { type: 'string', description: 'A few plain words saying what this part covers' },
          // No minimum/maximum: Claude's structured outputs don't support number limits.
          score: { type: 'integer', description: 'How good this part is, from 1 to 10' },
        },
      },
    },
  },
};

// The sponsor reads' answer format, in Gemini's spelling and in Claude and GPT's.
const SPONSOR_SCHEMA = {
  type: 'OBJECT',
  properties: {
    sponsors: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { start: { type: 'STRING' }, end: { type: 'STRING' } },
        required: ['start', 'end'],
      },
    },
  },
  required: ['sponsors'],
};

const SPONSOR_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['sponsors'],
  properties: {
    sponsors: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['start', 'end'],
        properties: { start: { type: 'string' }, end: { type: 'string' } },
      },
    },
  },
};

// The server imports this file as a module, where the names above stay private, so it reads them here.
globalThis.goodPartsPrompt = { FORMAT, transcriptPrompt, JSON_SCHEMA, sponsorPrompt, SPONSOR_JSON_SCHEMA };
