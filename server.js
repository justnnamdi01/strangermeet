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
const waitingQueue = [];   // socket IDs waiting for a match
const activePairs  = {};   // socketId → partnerSocketId
const userProfiles = {};   // socketId → { username, age, sex }

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

function tryMatch() {
  while (waitingQueue.length >= 2) {
    const callerID  = waitingQueue.shift();
    const calleeID  = waitingQueue.shift();

    const caller = io.sockets.sockets.get(callerID);
    const callee = io.sockets.sockets.get(calleeID);

    // Make sure both sockets are still connected
    if (!caller || !callee) {
      // Put the valid one back
      if (caller) waitingQueue.unshift(callerID);
      if (callee) waitingQueue.unshift(calleeID);
      continue;
    }

    activePairs[callerID] = calleeID;
    activePairs[calleeID] = callerID;

    const callerProfile = userProfiles[callerID] || null;
    const calleeProfile = userProfiles[calleeID] || null;

    // Tell caller to initiate (create offer), send callee's profile
    caller.emit('matched', { role: 'caller', partnerId: calleeID, partnerProfile: calleeProfile });
    // Tell callee to wait for offer, send caller's profile
    callee.emit('matched', { role: 'callee', partnerId: callerID, partnerProfile: callerProfile });

    console.log(`✅ Paired: ${callerID.slice(0,6)} ↔ ${calleeID.slice(0,6)}`);
  }
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
    removeFromQueue(socket.id);

    // Add to waiting queue and try to match
    waitingQueue.push(socket.id);
    socket.emit('searching');
    console.log(`🔍 Queued: ${socket.id.slice(0,6)} | Queue: ${waitingQueue.length}`);
    tryMatch();
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
    const partnerId = activePairs[socket.id];
    if (!partnerId || !text) return;
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
        tryMatch();
      }
    }
    removeFromQueue(socket.id);
    // Re-queue self
    waitingQueue.push(socket.id);
    socket.emit('searching');
    tryMatch();
  });

  // ── Disconnect ────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    totalOnline = Math.max(0, totalOnline - 1);
    broadcastOnlineCount();
    delete userProfiles[socket.id];

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
      }
    }
    console.log(`❌ Disconnected: ${socket.id.slice(0,6)} | Online: ${totalOnline}`);
  });
});

// ─── Health check endpoint ───────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status:  'ok',
    online:  totalOnline,
    waiting: waitingQueue.length,
    pairs:   Object.keys(activePairs).length / 2,
  });
});

// ─── Start ───────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 StrangerMeet server running on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health\n`);
});
