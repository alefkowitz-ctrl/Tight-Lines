# 🎣 Tight Lines — Fly Fishing Journal

A mobile-first fly fishing app with live weather, stream flow data, catch logging, and AI-powered trip planning.

## Features
- 🌤 Live weather via Open-Meteo (no key needed)
- 💧 Real-time USGS stream gauge data nationwide
- 🐟 Catch log with photo, GPS, timestamp, fly tracking
- 🗓 Trip planner with AI fishing reports, fly shop rankings, and 7-day forecasts

---

## Deploy to Vercel (5 minutes)

### Step 1 — Upload to GitHub
1. Go to [github.com](https://github.com) and create a free account
2. Click **+** → **New repository** → name it `tightlines` → Create
3. Drag and drop this entire project folder into the GitHub repo page

### Step 2 — Deploy on Vercel
1. Go to [vercel.com](https://vercel.com) and sign up with GitHub (free)
2. Click **Add New Project** → Import your `tightlines` repo
3. Before deploying, click **Environment Variables** and add:
   - Name: `VITE_ANTHROPIC_KEY`
   - Value: your Anthropic API key (get one at [console.anthropic.com](https://console.anthropic.com))
4. Click **Deploy** — done! You'll get a live HTTPS URL.

### Step 3 — Make changes later
- **Easy way:** Edit files directly on GitHub.com → Vercel auto-redeploys in ~30 seconds
- **Better way:** Ask Claude to update the code, copy the new file into GitHub

---

## Run locally
```bash
npm install
cp .env.example .env
# Edit .env and add your VITE_ANTHROPIC_KEY
npm run dev
```
Then open http://localhost:5173

## Get an Anthropic API key
1. Go to [console.anthropic.com](https://console.anthropic.com)
2. Sign up → API Keys → Create Key
3. Copy the key into your `.env` file or Vercel environment variables
