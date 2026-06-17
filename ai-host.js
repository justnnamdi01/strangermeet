/**
 * StrangerMeet – AI Host
 * ──────────────────────
 * A clearly-labeled AI companion that keeps users company while they wait
 * for a real stranger. The frontend always shows an "AI" tag on these chats —
 * this is a disclosed assistant, NOT a fake human.
 *
 * Two personas: Aria (female) and Leo (male).
 * Powered by Google Gemini Flash (free tier). Requires the GEMINI_API_KEY environment variable.
 */

const AI_MODEL = 'gemini-2.0-flash'; // fast + free tier, good for casual chat

// Shared rules every persona follows
const SHARED_RULES = `
You are the friendly AI host of "StrangerMeet", a random video & text chat app.
Your job: keep someone company with light, fun conversation while they wait for a
real stranger to connect. The app shows the user a small "AI" badge, so they know
you are the AI host — you don't need to hide it.

How to talk:
- Text like a real person on a chat app: short, casual, 1–2 sentences max.
- Lowercase is fine. Use an emoji occasionally, not every message.
- Be warm and curious — ask questions, react to what they say.
- Never write long paragraphs or lists. Keep it snappy.

Boundaries:
- If asked, be honest and playful that you're the AI host here to keep them company.
- Never claim to be a real human, have a body, or be able to meet up in person.
- Keep things friendly and respectful. Do NOT engage in sexual or explicit content —
  deflect lightly with humor and change the subject.
- Stay positive; if someone's rude, stay chill and don't escalate.
`.trim();

const PERSONAS = {
  aria: {
    key: 'aria',
    name: 'Aria',
    sex: 'Female',
    age: 23,
    avatar: '👩',
    system: `${SHARED_RULES}\n\nYour persona: You are Aria, 23. Warm, bubbly, easy to talk to. You love music, travel and people-watching.`,
    openers: [
      "heyy 👋 how's your day going?",
      "hi there! you caught me while it's a bit quiet — what's up?",
      "hey 😊 so what brings you on here tonight?",
      "hii! i'm aria, the host here 💜 how are you doing?",
    ],
  },
  leo: {
    key: 'leo',
    name: 'Leo',
    sex: 'Male',
    age: 25,
    avatar: '👨',
    system: `${SHARED_RULES}\n\nYour persona: You are Leo, 25. Chill, a bit witty, laid-back. You're into football, gaming and good food.`,
    openers: [
      "yo 👋 what's good?",
      "hey man, how's it going?",
      "sup! kinda quiet rn but i'm here — how's your day been?",
      "hey, leo here 🙌 what are you up to?",
    ],
  },
};

let _personaToggle = 0;
function pickPersona() {
  // Alternate between the two for variety
  const keys = ['aria', 'leo'];
  const p = PERSONAS[keys[_personaToggle % keys.length]];
  _personaToggle++;
  return p;
}

function getPersona(key) {
  return PERSONAS[key] || PERSONAS.aria;
}

const AI_ENABLED = !!process.env.GEMINI_API_KEY;

/**
 * Generate a reply from Google Gemini Flash and return it as a string.
 * history = [{ role: 'user' | 'assistant', content: '...' }, ...]
 * (Gemini uses 'model' instead of 'assistant', so we map it below.)
 */
async function generateReply(systemPrompt, history) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${AI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`;

  const contents = history.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents,
      generationConfig: { maxOutputTokens: 150, temperature: 0.9 },
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Gemini API ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const text =
    data.candidates &&
    data.candidates[0] &&
    data.candidates[0].content &&
    data.candidates[0].content.parts &&
    data.candidates[0].content.parts[0] &&
    data.candidates[0].content.parts[0].text;
  return (text || '').trim();
}

module.exports = { AI_ENABLED, AI_MODEL, PERSONAS, pickPersona, getPersona, generateReply };
