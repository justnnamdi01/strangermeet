# StrangerMeet – Deployment Guide

## What You Have
```
strangerapp-backend/
  server.js          ← Node.js + Socket.io backend (matchmaking + WebRTC signaling)
  package.json       ← Dependencies
  public/
    index.html       ← Full frontend with real WebRTC
```

---

## Option A: Deploy on Railway (Easiest – Free Tier Available)

1. **Install Node.js** on your computer: https://nodejs.org (download LTS)

2. **Test locally first**
   ```bash
   cd strangerapp-backend
   npm install
   npm start
   ```
   Open http://localhost:3000 in TWO browser tabs — they will match and video chat!

3. **Push to GitHub**
   - Create a free account at https://github.com
   - Create a new repo called `strangermeet`
   - Upload the `strangerapp-backend` folder

4. **Deploy on Railway**
   - Go to https://railway.app → Sign up (free)
   - Click "New Project" → "Deploy from GitHub repo"
   - Select your repo
   - Railway auto-detects Node.js and runs `npm start`
   - Click "Generate Domain" → you get a free URL like `strangermeet.up.railway.app`
   - Share that URL with the world! ✅

---

## Option B: Deploy on Render (Also Free)

1. Push your code to GitHub (same as above)
2. Go to https://render.com → New → Web Service
3. Connect your GitHub repo
4. Set:
   - Build command: `npm install`
   - Start command: `node server.js`
5. Click Deploy → get a free `.onrender.com` URL

---

## Add a Custom Domain (Optional)
- Buy a domain on Namecheap (~$10/year): https://namecheap.com
- In Railway/Render settings → Custom Domain → enter your domain
- Update DNS records as instructed

---

## For Worldwide Reliability – Add a TURN Server

STUN servers work for ~85% of users. For the remaining 15% (behind corporate firewalls,
strict NATs), add a TURN server. Easiest option:

**Twilio TURN (free trial)**
1. Sign up at https://twilio.com
2. Go to Console → TURN Credentials
3. In `public/index.html`, find the ICE_SERVERS config and add:
```js
{
  urls: 'turn:global.turn.twilio.com:3478?transport=udp',
  username: 'YOUR_TWILIO_USERNAME',
  credential: 'YOUR_TWILIO_CREDENTIAL',
}
```

---

## Health Check
Once deployed, visit: `https://your-app-url/health`
You'll see: `{"status":"ok","online":5,"waiting":2,"pairs":1}`

---

## Next Steps
- Add Google Login (Firebase Auth)  
- Add user profiles (username, age, sex)  
- Add a database (Supabase / MongoDB Atlas)  
- Add content moderation (report button, auto-ban system)
