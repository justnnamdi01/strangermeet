/**
 * StrangerMeet – Random fallback account
 * ───────────────────────────────
 * When a user waits too long for a real stranger, we show a random account
 * with a female or male profile and a short canned chat response flow.
 * This is not a live AI agent or third-party API call.
 */

const PERSONA_TEMPLATES = {
  Female: ['Ava', 'Maya', 'Zoe', 'Lila', 'Nina', 'Sophie', 'Chloe', 'Mia', 'Emma', 'Layla'],
  Male: ['Noah', 'Liam', 'Ethan', 'Jasper', 'Mason', 'Caleb', 'Owen', 'Leo', 'Isaac', 'Ezra'],
};

const OPENERS = [
  "hey! nice to meet you 🙂",
  "hi there — i was just waiting for a chat too.",
  "heyy 👋 just passing the time while the app finds someone else.",
  "what's up? i'm free to chat while you wait!",
];

const GENERIC_REPLIES = [
  "that's cool — tell me more!",
  "oh nice, i can totally relate to that.",
  "haha, i love that. what's your favourite thing to do on weekends?",
  "sounds fun! do you usually do that a lot?",
  "i'm here if you want to keep chatting while the app searches.",
  "interesting! i like hearing about that.",
];

const PERSONA_CACHE = {};
const AI_ENABLED = true;

function randomAge() {
  let age;
  do {
    age = Math.floor(Math.random() * 28) + 18; // 18-45
  } while (age === 28);
  return age;
}

function pickPersona() {
  const sex = Math.random() < 0.5 ? 'Female' : 'Male';
  const names = PERSONA_TEMPLATES[sex];
  const name = names[Math.floor(Math.random() * names.length)];
  const age = randomAge();
  const key = `${sex.toLowerCase()}-${name.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const persona = {
    key,
    name,
    sex,
    age,
    avatar: sex === 'Female' ? '👩' : '👨',
    openers: OPENERS,
  };
  PERSONA_CACHE[key] = persona;
  return persona;
}

function getPersona(key) {
  return PERSONA_CACHE[key] || null;
}

async function generateReply(persona, history) {
  const lastMessage = history && history.length
    ? String(history[history.length - 1].content || '').toLowerCase()
    : '';

  const simpleResponses = [];

  if (/hi|hello|hey|hiya/.test(lastMessage)) {
    simpleResponses.push(`hey ${persona.name}! how's your day going?`);
    simpleResponses.push(`nice to meet you — i'm ${persona.name}.`);
  }
  if (/age|how old|old are/.test(lastMessage)) {
    simpleResponses.push(`i'm ${persona.age}, and i'm keeping you company while the app finds someone else.`);
  }
  if (/name|who are|what's your name/.test(lastMessage)) {
    simpleResponses.push(`i'm ${persona.name}. what should i call you?`);
  }
  if (/where|from/.test(lastMessage)) {
    simpleResponses.push(`i'm just hanging out here in the app, waiting for a real stranger to connect.`);
  }

  const reply = simpleResponses.length
    ? simpleResponses[Math.floor(Math.random() * simpleResponses.length)]
    : GENERIC_REPLIES[Math.floor(Math.random() * GENERIC_REPLIES.length)];

  return reply;
}

module.exports = { AI_ENABLED, pickPersona, getPersona, generateReply };
