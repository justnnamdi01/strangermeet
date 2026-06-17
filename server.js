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
});

app.use(cors());
app.use(express.json());

// Serve the frontend from /public
app.use(express.static(path.join(__dirname, 'public')));

// ─── State ───────────────────────────────────────────────────────────
const waitingQueue  = [];   // socket IDs waiting for a real match
const activePairs   = {};   // socketId → partnerSocketId
const userProfiles  = {};   // socketId → { age, sex }
const aiSessions    = {};   // socketId → { persona, history: [] }  (chatting with AI host)
const waitingTimers = {};   // socketId → timeout handle (no-match → AI fallback)

// How long a user waits with no real match before the AI host steps in
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

  // 2) If a real user is still waiting alone, rescue someone from an AI chat
  //    so two real people get connected instead of one sitting with the AI host.
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

// ─── AI host helpers ─────────────────────────────────────────────────
function clearAITimer(socketId) {
  if (waitingTimers[socketId]) {
    clearTimeout(waitingTimers[socketId]);
    delete waitingTimers[socketId];
  }
}

// Schedule the AI host to step in if this user is still waiting after a while
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
  console.log(`🤖 AI host (${persona.name}) joined: ${socketId.slice(0,6)}`);

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
    reply = await ai.callClaude(persona.system, session.history);
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
    // Chatting with the AI host? Route to Claude instead of a partner.
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

// ─── Health check endpoint ───────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status:     'ok',
    online:     totalOnline,
    waiting:    waitingQueue.length,
    pairs:      Object.keys(activePairs).length / 2,
    aiChats:    Object.keys(aiSessions).length,
    aiEnabled:  ai.AI_ENABLED,
  });
});

// ─── Start ───────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 StrangerMeet server running on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
  console.log(`   AI host: ${ai.AI_ENABLED ? '✅ enabled' : '⚠️  disabled (set ANTHROPIC_API_KEY)'}\n`);
});
