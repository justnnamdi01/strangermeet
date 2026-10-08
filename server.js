/**
 * StrangerMeet – Backend Server
 * ─────────────────────────────
 * Express + Socket.io WebRTC signaling server.
 *
 * Flow:
 *  1. User connects → added to waitingQueue
 *  2. When 2+ users are waiting → pair them
 *  3. One becomes "caller", the other "callee"
 *  4. Caller creates offer → relayed to callee
 *  5. Callee creates answer → relayed to caller
 *  6. ICE candidates exchanged → direct P2P video established
 *  7. Either user can press "Next" → both get disconnected, re-queued
 */

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const ai      = require('./ai-host');

// ─── Setup ───────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*',          // In production, restrict to your domain
    methods: ['GET', 'POST'],
  },
  transports: ['websocket', 'polling'],
  // During a call the media is peer-to-peer, so the signaling socket goes idle
  // and only heartbeats keep it alive. Give brief network blips more room before
  // the socket is considered dead (default pingTimeout is only 20s).
  pingInterval: 25000,
  pingTimeout: 60000,
});

app.use(cors());
app.use(express.json());

// Serve the frontend from /public
app.use(express.static(path.join(__dirname, 'public')));

// ─── State ───────────────────────────────────────────────────────────
const waitingQueue  = [];   // socket IDs waiting for a real match
const activePairs   = {};   // socketId → partnerSocketId
const userProfiles  = {};   // socketId → { age, sex }
const aiSessions    = {};   // socketId → { persona, history: [] }  (chatting with fallback account)
const waitingTimers = {};   // socketId → timeout handle (no-match → fallback account)

// How long a user waits with no real match before the fallback account steps in
const AI_FALLBACK_MS = 20000; // 20 seconds

let totalOnline = 0;

// ─── Helpers ─────────────────────────────────────────────────────────
function removeFromQueue(socketId) {
  const idx = waitingQueue.indexOf(socketId);
  if (idx !== -1) waitingQueue.splice(idx, 1);
}

function unpair(socketId) {
  const partnerId = activePairs[socketId];
  delete activePairs[socketId];
  if (partnerId) {
    delete activePairs[partnerId];
    return partnerId;
  }
  return null;
}

// Pair two real users together (sets up the WebRTC offer/answer roles)
function pairUsers(callerID, calleeID) {
  const caller = io.sockets.sockets.get(callerID);
  const callee = io.sockets.sockets.get(calleeID);

  if (!caller || !callee) {
    if (caller) waitingQueue.unshift(callerID);
    if (callee) waitingQueue.unshift(calleeID);
    return false;
  }

  clearAITimer(callerID);
  clearAITimer(calleeID);

  activePairs[callerID] = calleeID;
  activePairs[calleeID] = callerID;

  const callerProfile = userProfiles[callerID] || null;
  const calleeProfile = userProfiles[calleeID] || null;

  caller.emit('matched', { role: 'caller', partnerId: calleeID, partnerProfile: calleeProfile });
  callee.emit('matched', { role: 'callee', partnerId: callerID, partnerProfile: callerProfile });

  console.log(`✅ Paired: ${callerID.slice(0,6)} ↔ ${calleeID.slice(0,6)}`);
  return true;
}

function tryMatch() {
  // 1) Pair any real users currently in the queue
  while (waitingQueue.length >= 2) {
    pairUsers(waitingQueue.shift(), waitingQueue.shift());
  }

  // 2) If a real user is still waiting alone, rescue someone from a fallback chat
  //    so two real people get connected instead of one sitting with the fallback account.
  while (waitingQueue.length >= 1 && Object.keys(aiSessions).length > 0) {
    const aiUserId = Object.keys(aiSessions)[0];
    const aiSock   = io.sockets.sockets.get(aiUserId);
    endAISession(aiUserId, /* notify */ true);
    if (!aiSock) continue;               // socket gone, skip
    waitingQueue.push(aiUserId);
    while (waitingQueue.length >= 2) {
      pairUsers(waitingQueue.shift(), waitingQueue.shift());
    }
  }
}

// ─── Random fallback account helpers ──────────────────────────────────
function clearAITimer(socketId) {
  if (waitingTimers[socketId]) {
    clearTimeout(waitingTimers[socketId]);
    delete waitingTimers[socketId];
  }
}

// Schedule a random fallback account to step in if this user is still waiting
function scheduleAIFallback(socketId) {
  if (!ai.AI_ENABLED) return;
  clearAITimer(socketId);
  waitingTimers[socketId] = setTimeout(() => assignAI(socketId), AI_FALLBACK_MS);
}

function endAISession(socketId, notify) {
  if (!aiSessions[socketId]) return;
  delete aiSessions[socketId];
  if (notify) {
    const s = io.sockets.sockets.get(socketId);
    if (s) s.emit('real_found');
  }
}

// Move a still-waiting user into a chat with the AI host
function assignAI(socketId) {
  delete waitingTimers[socketId];

  const idx = waitingQueue.indexOf(socketId);
  if (idx === -1 || activePairs[socketId]) return; // already matched or gone
  const sock = io.sockets.sockets.get(socketId);
  if (!sock) return;

  waitingQueue.splice(idx, 1);
  const persona = ai.pickPersona();
  aiSessions[socketId] = { persona: persona.key, history: [] };

  sock.emit('matched', {
    role: 'callee',
    isAI: true,
    partnerProfile: { name: persona.name, age: persona.age, sex: persona.sex, avatar: persona.avatar },
  });
  console.log(`✨ Fallback account (${persona.name}, ${persona.sex}, ${persona.age}) joined: ${socketId.slice(0,6)}`);

  // Send a natural opener after a short, human-like delay
  const opener = persona.openers[Math.floor(Math.random() * persona.openers.length)];
  sock.emit('partner_typing', true);
  setTimeout(() => {
    if (!aiSessions[socketId]) return;
    const s = io.sockets.sockets.get(socketId);
    if (!s) return;
    s.emit('partner_typing', false);
    s.emit('chat_message', { text: opener });
    aiSessions[socketId].history.push({ role: 'assistant', content: opener });
  }, 1400 + Math.random() * 1400);
}

// Generate and send an AI reply for a user's message
async function handleAIMessage(socketId, userText) {
  const session = aiSessions[socketId];
  if (!session) return;

  session.history.push({ role: 'user', content: userText });
  if (session.history.length > 20) session.history = session.history.slice(-20);

  const sock = io.sockets.sockets.get(socketId);
  if (!sock) return;
  sock.emit('partner_typing', true);

  let reply;
  try {
    const persona = ai.getPersona(session.persona);
    reply = await ai.generateReply(persona.system, session.history);
  } catch (e) {
    console.error('AI error:', e.message);
    reply = "sorry, my connection glitched for a sec 😅 what were you saying?";
  }
  if (!reply) reply = "hmm i didn't catch that — say again?";

  // Session may have ended (user left / real match found) while awaiting Claude
  if (!aiSessions[socketId]) return;

  // Simulate realistic typing time based on reply length
  const delay = Math.min(3500, 600 + reply.length * 25);
  setTimeout(() => {
    if (!aiSessions[socketId]) return;
    const s = io.sockets.sockets.get(socketId);
    if (!s) return;
    s.emit('partner_typing', false);
    s.emit('chat_message', { text: reply });
    session.history.push({ role: 'assistant', content: reply });
  }, delay);
}

function broadcastOnlineCount() {
  io.emit('online_count', totalOnline);
}

// ─── Socket Events ───────────────────────────────────────────────────
io.on('connection', (socket) => {
  totalOnline++;
  broadcastOnlineCount();
  console.log(`🔌 Connected: ${socket.id.slice(0,6)} | Online: ${totalOnline}`);

  // ── Save profile ─────────────────────────────────────────────────
  socket.on('set_profile', (profile) => {
    userProfiles[socket.id] = {
      age: parseInt(profile.age) || 18,
      sex: ['Male','Female','Other'].includes(profile.sex) ? profile.sex : 'Other',
    };
  });

  // ── User joins the queue ──────────────────────────────────────────
  socket.on('find_stranger', () => {
    // Remove from any existing pair first
    const oldPartner = unpair(socket.id);
    if (oldPartner) {
      const partnerSocket = io.sockets.sockets.get(oldPartner);
      if (partnerSocket) {
        partnerSocket.emit('partner_left');
      }
    }
    endAISession(socket.id);
    clearAITimer(socket.id);
    removeFromQueue(socket.id);

    // Add to waiting queue and try to match
    waitingQueue.push(socket.id);
    socket.emit('searching');
    console.log(`🔍 Queued: ${socket.id.slice(0,6)} | Queue: ${waitingQueue.length}`);
    tryMatch();

    // If still unmatched, line up the AI host as a fallback
    if (waitingQueue.includes(socket.id)) scheduleAIFallback(socket.id);
  });

  // ── WebRTC Signaling relay ────────────────────────────────────────
  // Offer (caller → callee)
  socket.on('offer', ({ offer }) => {
    const partnerId = activePairs[socket.id];
    if (!partnerId) return;
    io.to(partnerId).emit('offer', { offer, from: socket.id });
  });

  // Answer (callee → caller)
  socket.on('answer', ({ answer }) => {
    const partnerId = activePairs[socket.id];
    if (!partnerId) return;
    io.to(partnerId).emit('answer', { answer });
  });

  // ICE candidate (either direction)
  socket.on('ice_candidate', ({ candidate }) => {
    const partnerId = activePairs[socket.id];
    if (!partnerId) return;
    io.to(partnerId).emit('ice_candidate', { candidate });
  });

  // ── Text chat relay ───────────────────────────────────────────────
  socket.on('chat_message', ({ text }) => {
    if (!text) return;
    // Chatting with the fallback account? Route to the local canned responder.
    if (aiSessions[socket.id]) {
      handleAIMessage(socket.id, String(text).slice(0, 500));
      return;
    }
    const partnerId = activePairs[socket.id];
    if (!partnerId) return;
    io.to(partnerId).emit('chat_message', { text });
  });

  // ── User clicks "Next" ────────────────────────────────────────────
  socket.on('next_stranger', () => {
    const partnerId = unpair(socket.id);
    if (partnerId) {
      const partnerSocket = io.sockets.sockets.get(partnerId);
      if (partnerSocket) {
        partnerSocket.emit('partner_left');
        // Re-queue the partner automatically
        waitingQueue.push(partnerId);
        partnerSocket.emit('searching');
        scheduleAIFallback(partnerId);
      }
    }
    // Leaving an AI chat counts as "next" too
    endAISession(socket.id);
    clearAITimer(socket.id);
    removeFromQueue(socket.id);

    // Re-queue self
    waitingQueue.push(socket.id);
    socket.emit('searching');
    tryMatch();
    if (waitingQueue.includes(socket.id)) scheduleAIFallback(socket.id);
  });

  // ── Disconnect ────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    totalOnline = Math.max(0, totalOnline - 1);
    broadcastOnlineCount();
    delete userProfiles[socket.id];
    endAISession(socket.id);
    clearAITimer(socket.id);

    const partnerId = unpair(socket.id);
    removeFromQueue(socket.id);

    if (partnerId) {
      const partnerSocket = io.sockets.sockets.get(partnerId);
      if (partnerSocket) {
        partnerSocket.emit('partner_left');
        // Re-queue partner
        waitingQueue.push(partnerId);
        partnerSocket.emit('searching');
        tryMatch();
        if (waitingQueue.includes(partnerId)) scheduleAIFallback(partnerId);
      }
    }
    console.log(`❌ Disconnected: ${socket.id.slice(0,6)} | Online: ${totalOnline}`);
  });
});

// ─── Early-access email signups ──────────────────────────────────────
// Stored as JSON on disk. On Railway, point DATA_DIR at a mounted Volume so
// the list survives redeploys (the default filesystem is wiped each deploy).
const DATA_DIR    = process.env.DATA_DIR || __dirname;
const EMAILS_FILE = path.join(DATA_DIR, 'emails.json');
// Head-start for the signup counter. Defaults to 250; override with COUNT_BASE.
const COUNT_BASE  = parseInt(process.env.COUNT_BASE) || 250;

let subscribers = [];
try {
  if (fs.existsSync(EMAILS_FILE)) {
    subscribers = JSON.parse(fs.readFileSync(EMAILS_FILE, 'utf8')) || [];
  }
} catch (e) {
  console.error('Could not read emails file:', e.message);
}

function saveSubscribers() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(EMAILS_FILE, JSON.stringify(subscribers, null, 2));
  } catch (e) {
    console.error('Could not save emails file:', e.message);
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ─── Email sending (via Resend) ──────────────────────────────────────
// Set these on Railway to turn emails on:
//   RESEND_API_KEY  – your Resend API key (required to send anything)
//   FROM_EMAIL      – sender, e.g. "StrangerMeet <hello@strangermeets.com>"
//                     (must be a Resend-verified domain; defaults to Resend's
//                      sandbox sender, which can only email YOUR own address)
//   NOTIFY_EMAIL    – where owner signup alerts go (e.g. your inbox)
const EMAIL_ENABLED = !!process.env.RESEND_API_KEY;
const FROM_EMAIL    = process.env.FROM_EMAIL || 'StrangerMeet <onboarding@resend.dev>';
const NOTIFY_EMAIL  = process.env.NOTIFY_EMAIL || '';

async function sendEmail(to, subject, html) {
  if (!EMAIL_ENABLED || !to) return;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: FROM_EMAIL, to: [to], subject, html }),
    });
    if (!r.ok) console.error('Email send failed:', r.status, await r.text().catch(() => ''));
  } catch (e) {
    console.error('Email error:', e.message);
  }
}

function welcomeEmailHtml() {
  return `
    <div style="font-family:system-ui,Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#1a1a1a">
      <h2 style="margin:0 0 8px">You're on the list 🎉</h2>
      <p style="color:#555;line-height:1.6">
        Thanks for signing up for early access to <strong>StrangerMeet</strong> —
        meet random people from around the world, instantly.
      </p>
      <p style="color:#555;line-height:1.6">
        We'll email you the moment we launch new features. No spam, promise.
      </p>
      <p style="margin-top:24px">
        <a href="https://www.strangermeets.com" style="background:#7c3aed;color:#fff;
          text-decoration:none;padding:12px 24px;border-radius:50px;font-weight:600">
          Visit StrangerMeet</a>
      </p>
      <p style="color:#999;font-size:12px;margin-top:24px">You received this because you signed up at strangermeets.com. 18+ only.</p>
    </div>`;
}

app.post('/api/subscribe', (req, res) => {
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) {
    return res.status(400).json({ error: 'Please enter a valid email.' });
  }
  const exists = subscribers.some((s) => s.email === email);
  if (!exists) {
    subscribers.push({ email, at: new Date().toISOString() });
    saveSubscribers();
    console.log(`📧 New signup: ${email} | Total: ${subscribers.length}`);

    // Fire-and-forget emails (don't block the response)
    sendEmail(email, "You're on the StrangerMeet early-access list 🎉", welcomeEmailHtml());
    if (NOTIFY_EMAIL) {
      sendEmail(
        NOTIFY_EMAIL,
        `New StrangerMeet signup (#${subscribers.length})`,
        `<p>New early-access signup:</p><p><strong>${email}</strong></p><p>Total real signups: ${subscribers.length}</p>`
      );
    }
  }
  res.json({ ok: true, already: exists, count: subscribers.length + COUNT_BASE });
});

app.get('/api/subscribe/count', (req, res) => {
  res.json({ count: subscribers.length + COUNT_BASE });
});

// ─── WebRTC ICE servers (STUN + optional TURN relay) ─────────────────
// TURN lets users behind strict firewalls/NATs (~15%) connect. Configure it
// with TURN_URL / TURN_USERNAME / TURN_CREDENTIAL env vars on Railway. TURN_URL
// may be a comma-separated list (e.g. udp + tcp + tls variants). Without them,
// only free STUN is returned (direct connections only).
app.get('/api/ice', (req, res) => {
  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
  ];
  if (process.env.TURN_URL && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
    const urls = process.env.TURN_URL.split(',').map((u) => u.trim()).filter(Boolean);
    iceServers.push({
      urls,
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL,
    });
  }
  res.json({ iceServers });
});

// ─── Visitor tracking ────────────────────────────────────────────────
// Counts total pageviews and unique visitors (the browser reports whether it's
// a first-time visit via localStorage). Stored on disk next to the emails.
const VISITS_FILE = path.join(DATA_DIR, 'visits.json');
let visits = { pageviews: 0, uniques: 0, days: {} };
try {
  if (fs.existsSync(VISITS_FILE)) {
    visits = Object.assign(visits, JSON.parse(fs.readFileSync(VISITS_FILE, 'utf8')) || {});
  }
} catch (e) {
  console.error('Could not read visits file:', e.message);
}

let visitsDirty = false;
function saveVisits() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(VISITS_FILE, JSON.stringify(visits));
  } catch (e) {
    console.error('Could not save visits file:', e.message);
  }
}
// Flush to disk at most once every 10s to avoid a write on every single hit.
setInterval(() => { if (visitsDirty) { visitsDirty = false; saveVisits(); } }, 10000).unref();

function todayKey() { return new Date().toISOString().slice(0, 10); }

app.post('/api/visit', (req, res) => {
  const firstTime = !!(req.body && req.body.firstTime);
  const day = todayKey();
  if (!visits.days[day]) visits.days[day] = { pageviews: 0, uniques: 0 };

  visits.pageviews++;
  visits.days[day].pageviews++;
  if (firstTime) {
    visits.uniques++;
    visits.days[day].uniques++;
  }
  visitsDirty = true;
  res.json({ ok: true });
});

// ─── Admin: view & download the email list ───────────────────────────
// Protected by HTTP Basic Auth. Username is ignored; password must match the
// ADMIN_PASSWORD env var. If ADMIN_PASSWORD is unset, these routes 404 so the
// list is never exposed.
function requireAdmin(req, res) {
  const pass = process.env.ADMIN_PASSWORD;
  if (!pass) { res.status(404).send('Not found'); return false; }
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  let ok = false;
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    ok = decoded.slice(decoded.indexOf(':') + 1) === pass;
  }
  if (!ok) {
    res.set('WWW-Authenticate', 'Basic realm="StrangerMeet Admin"').status(401).send('Authentication required');
    return false;
  }
  return true;
}

function toCsv(rows) {
  return rows
    .map((r) => r.map((f) => `"${String(f).replace(/"/g, '""')}"`).join(','))
    .join('\r\n');
}

app.get('/admin', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const today = visits.days[todayKey()] || { pageviews: 0, uniques: 0 };
  const stat = (label, value, color) => `
    <div style="background:#18181c;border:1px solid #2e2e38;border-radius:16px;
      padding:20px 28px;min-width:150px;text-align:center">
      <div style="font-size:34px;font-weight:800;color:${color}">${Number(value).toLocaleString()}</div>
      <div style="font-size:12px;color:#8888a0;margin-top:4px">${label}</div>
    </div>`;
  res.send(`<!doctype html><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>StrangerMeet · Dashboard</title>
    <body style="font-family:system-ui;background:#0d0d0f;color:#f0f0f5;display:flex;
      flex-direction:column;align-items:center;justify-content:center;min-height:100vh;gap:24px;padding:24px;margin:0">
      <h1 style="font-size:22px;margin:0">📊 StrangerMeet dashboard</h1>
      <div style="display:flex;flex-wrap:wrap;gap:14px;justify-content:center">
        ${stat('Unique visitors', visits.uniques, '#22d3ee')}
        ${stat('Total pageviews', visits.pageviews, '#3b82f6')}
        ${stat('Visitors today', today.uniques, '#22c55e')}
        ${stat('Email signups', subscribers.length, '#a855f7')}
      </div>
      <a href="/admin/emails.csv" download
        style="background:linear-gradient(135deg,#7c3aed,#a855f7);color:#fff;
        padding:14px 32px;border-radius:50px;text-decoration:none;font-weight:700">
        Download email list (CSV)</a>

      <div style="width:100%;max-width:520px;background:#18181c;border:1px solid #2e2e38;
        border-radius:16px;padding:24px;margin-top:8px">
        <h2 style="font-size:16px;margin:0 0 4px">📣 Email all subscribers</h2>
        <p style="font-size:12px;color:#8888a0;margin:0 0 14px">
          ${EMAIL_ENABLED
            ? `Sends to all ${subscribers.length} real signup(s). Emails are off-limits to the 250 base count.`
            : '⚠️ Email sending is OFF. Set RESEND_API_KEY on Railway to enable.'}
        </p>
        <form method="POST" action="/admin/broadcast" style="display:flex;flex-direction:column;gap:10px">
          <input name="subject" placeholder="Subject" required
            style="background:#222228;border:1px solid #2e2e38;border-radius:10px;padding:11px 14px;color:#f0f0f5;font-size:14px" />
          <textarea name="message" placeholder="Your message to everyone..." rows="6" required
            style="background:#222228;border:1px solid #2e2e38;border-radius:10px;padding:11px 14px;color:#f0f0f5;font-size:14px;font-family:inherit;resize:vertical"></textarea>
          <button type="submit" ${EMAIL_ENABLED ? '' : 'disabled'}
            style="background:linear-gradient(135deg,#7c3aed,#a855f7);color:#fff;border:none;
            padding:13px;border-radius:50px;font-weight:700;font-size:14px;cursor:pointer;opacity:${EMAIL_ENABLED ? '1' : '0.5'}">
            Send to all subscribers</button>
        </form>
      </div>
    </body>`);
});

// Send a message to every real subscriber (admin only). Runs in the background
// with a small gap between sends to respect Resend's rate limits.
app.post('/admin/broadcast', express.urlencoded({ extended: true }), async (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (!EMAIL_ENABLED) return res.status(400).send('Email sending is not configured (set RESEND_API_KEY).');

  const subject = String((req.body && req.body.subject) || '').trim();
  const message = String((req.body && req.body.message) || '').trim();
  if (!subject || !message) return res.status(400).send('Subject and message are required.');

  const html = `
    <div style="font-family:system-ui,Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#1a1a1a">
      ${message.split('\n').map((line) => `<p style="line-height:1.6;margin:0 0 12px">${line.replace(/</g, '&lt;')}</p>`).join('')}
      <p style="margin-top:20px"><a href="https://www.strangermeets.com" style="background:#7c3aed;color:#fff;text-decoration:none;padding:12px 24px;border-radius:50px;font-weight:600">Visit StrangerMeet</a></p>
      <p style="color:#999;font-size:12px;margin-top:24px">You received this because you joined the StrangerMeet early-access list. 18+ only.</p>
    </div>`;

  const recipients = subscribers.map((s) => s.email);
  res.send(`<body style="font-family:system-ui;background:#0d0d0f;color:#f0f0f5;text-align:center;padding:60px">
    <h2>📤 Sending to ${recipients.length} subscriber(s)…</h2>
    <p style="color:#8888a0">You can close this page. <a href="/admin" style="color:#a855f7">Back to dashboard</a></p></body>`);

  // Send sequentially in the background to stay under rate limits.
  (async () => {
    for (const to of recipients) {
      await sendEmail(to, subject, html);
      await new Promise((r) => setTimeout(r, 600));
    }
    console.log(`📣 Broadcast "${subject}" sent to ${recipients.length} subscriber(s)`);
  })();
});

app.get('/admin/emails.csv', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const rows = [['email', 'signed_up_at']].concat(subscribers.map((s) => [s.email, s.at]));
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="strangermeet-emails.csv"');
  res.send(toCsv(rows));
});

// ─── Health check endpoint ───────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status:     'ok',
    online:     totalOnline,
    waiting:    waitingQueue.length,
    pairs:      Object.keys(activePairs).length / 2,
    aiChats:    Object.keys(aiSessions).length,
    aiEnabled:  ai.AI_ENABLED,
    emailEnabled: EMAIL_ENABLED,
    signups:    subscribers.length + COUNT_BASE,
    visitors:   visits.uniques,
    pageviews:  visits.pageviews,
  });
});

// ─── Start ───────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 StrangerMeet server running on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
  console.log(`   fallback account: ${ai.AI_ENABLED ? '✅ enabled' : '⚠️  disabled'}`);
  console.log(`   email: ${EMAIL_ENABLED ? '✅ enabled' : '⚠️  disabled (set RESEND_API_KEY)'}\n`);
});
