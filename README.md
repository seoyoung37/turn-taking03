# InBetween

> Video conference that surfaces pre-speech signals — a parted lip, a lean, a glance — before a word is said.

## Features

- **Flat → Upright tiles** — non-speakers lie flat; the active speaker's tile rises upright
- **Pre-speech cues** via MediaPipe Face Landmarker (lip open, leaning forward, gazing at speaker)
- **Silence → Circle mode** — after 5s of silence, participants arrange in a slowly-rotating circle split by speaking time
- **Speaker detection** — LiveKit active speaker + local audio RMS
- **Invite link sharing** — copy link with room name baked in

## Quick Start

### 1. Install dependencies
```bash
npm install
```

### 2. Set environment variables

Create a `.env` file or set these in your shell / Railway dashboard:

```
LIVEKIT_URL=wss://your-livekit-server.livekit.cloud
LIVEKIT_API_KEY=your_api_key
LIVEKIT_API_SECRET=your_api_secret
PORT=3000
```

Get free LiveKit Cloud credentials at: https://cloud.livekit.io

### 3. Run locally
```bash
npm start
```

Open `http://localhost:3000` in your browser.

### 4. Deploy to Railway

1. Push this repo to GitHub (excluding `node_modules`)
2. Connect the repo to Railway (railway.app)
3. Add environment variables in Railway → Variables:
   - `LIVEKIT_URL`
   - `LIVEKIT_API_KEY`
   - `LIVEKIT_API_SECRET`
4. Railway automatically runs `npm start` and provides a public domain

## Project Structure

```
inbetween/
├── server.js           # Express server + LiveKit token endpoint
├── package.json
├── .gitignore
├── README.md
└── public/
    ├── index.html      # Join screen + meeting room HTML
    ├── style.css       # All styles (join, tiles, circle mode, controls)
    └── app.js          # All client logic (LiveKit, MediaPipe, cues)
```

## How It Works

### Tile States
| State | Trigger | CSS class |
|-------|---------|-----------|
| Flat (default) | Not speaking | — |
| Mouth open | Lip parting detected (unmuted) | `mouth-open` |
| Leaning | Lip open + body lean | `leaning` |
| Gaze pull | Lip open + looking at speaker | `gaze-pull` |
| Upright | Active speaker | `speaker` |
| Held upright | Just stopped speaking | `held-speaker` |

### Circle Mode
Triggers when:
- Circle mode feature is ON (toggle button)
- 2+ participants
- 5+ seconds of silence

Participants split into **outer ring** (spoke more) and **inner ring** (spoke less). The arrangement rotates slowly until someone speaks.

### Environment Notes
- MediaPipe face detection runs client-side — no server processing needed
- LiveKit handles all WebRTC media routing
- `speakingMs` is tracked per participant for inner/outer ring placement
