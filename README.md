<div align="center">

# 📲 StatusDrop (WAstatus)

**Send crisp, HD videos to your WhatsApp Status — no more blurry uploads.**

Upload a clip in the browser, and StatusDrop compresses it to WhatsApp's exact
Status spec, auto-splits long videos into parts, and delivers the finished clips
straight to your WhatsApp so you can forward them to your Status in full quality.

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20.x-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Tests](https://img.shields.io/badge/tests-181%20passing-brightgreen.svg)](#tests)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#contributing)

🌐 **[wastatusvideo.com](https://wastatusvideo.com)**

</div>

---

## The problem

WhatsApp aggressively re-compresses videos posted to Status, so a sharp clip
from your gallery ends up blurry and blocky for your viewers. StatusDrop solves
this by pre-encoding the video to the format WhatsApp's Status pipeline expects,
so the unavoidable re-encode is near-lossless — and by delivering it as a native
WhatsApp message you can **forward** to Status (which preserves quality far
better than saving-and-reposting).

## Features

- 🎞️ **In-browser video editor** — trim, crop, captions, no upload to third parties beyond your own storage
- 📐 **Smart compression** — encodes to WhatsApp's Status spec (1080×1920, tuned bitrate/GOP/faststart)
- ✂️ **Auto-split** — long videos are cut into ≤30s parts that fit WhatsApp's limits
- ⏱️ **Optional "longer clips" mode** — 720p, up to 60s per part, to fit under the 16 MB cap with fewer parts
- 🌍 **Multi-language** — English, Spanish, Hindi, Portuguese
- 🔒 **No login, no watermark, no ads** — files are deleted after delivery
- ♻️ **Self-healing pipeline** — timeouts, retries, stale-job recovery, and orphaned-storage cleanup

## How it works

```
┌──────────────────────┐        ┌─────────────────────┐        ┌──────────────────────┐
│  Browser editor       │  ───►  │  Cloudflare Worker   │  ───►  │  Cloudflare R2        │
│  (upload + edit)      │        │  (direct upload)     │        │  (object storage)     │
└──────────┬───────────┘        └─────────────────────┘        └──────────┬───────────┘
           │ POST /api/process (edit recipe + R2 keys)                     │ pull source
           ▼                                                               │
┌──────────────────────────────────────────────────────────────┐         │
│  Backend API  (Node / Express, Dockerized on Azure)           │ ◄───────┘
│   • validate recipe → ffmpeg render/compress/split            │
│   • upload output clips back to R2                            │
│   • hand off to WhatsApp delivery                             │
└──────────┬───────────────────────────────────────────────────┘
           │  user messages the number with a short reference code
           ▼
┌──────────────────────┐
│  Baileys (WhatsApp)   │  ───►  delivers the HD clips to the user's chat
└──────────────────────┘        (user forwards them to their Status)
```

1. The user edits a clip in the browser; media is uploaded directly to **Cloudflare R2** via a Worker.
2. The frontend posts an **edit recipe + R2 keys** to `/api/process`.
3. The backend validates the recipe, runs the **ffmpeg** render/compress/split pipeline, and uploads the output clips to R2.
4. It returns a short **reference code** and a WhatsApp deep link.
5. The user messages the number with that code; the bot (via **Baileys**) sends the finished clips, which the user forwards to their Status.
6. Delivered files are purged from R2; a background sweeper cleans any orphans.

## Tech stack

| Layer | Tech |
|-------|------|
| Frontend | Vanilla JS in-browser editor, static site on **Vercel** |
| Backend | **Node.js 20**, **Express 5** |
| Video | **ffmpeg** / **ffprobe** (`ffmpeg-static`), `@napi-rs/canvas` for text/sticker rasterization |
| Storage | **Cloudflare R2** (S3-compatible, AWS SDK v3) + Cloudflare Worker |
| WhatsApp | **Baileys** (multi-device) |
| Infra | **Docker** → **Azure App Service**, **GitHub Actions** CI/CD → GHCR |
| Testing | `node:test` + **fast-check** property-based tests |

## Getting started

> Requires **Node.js 20+**.

```bash
git clone https://github.com/Shamanthnp1/WAstatus.git
cd WAstatus
npm install

# Run the test suite
npm test

# Local UI harness — try the editor without Baileys/R2/WhatsApp
node dev-server.js

# Full server (needs the environment variables below)
npm start
```

### Environment variables

Create a `.env` (git-ignored — **never commit secrets**):

| Variable | Purpose |
|----------|---------|
| `PORT` | HTTP port (default `3000`) |
| `R2_ENDPOINT` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | Cloudflare R2 credentials |
| `R2_BUCKET_NAME` / `R2_PUBLIC_URL` | R2 bucket + public base URL |
| `WHATSAPP_BUSINESS_NUMBER` | Number in full international format (e.g. `+9198XXXXXXXX`) |
| `MAX_CONCURRENT_ENCODES` | Max simultaneous ffmpeg jobs (e.g. `3`) |
| `BAILEYS_AUTH_DIR` | Directory for the persisted WhatsApp session |
| `RESET_BAILEYS` | Set `true` once to re-link via pairing code, then back to `false` |
| `HUMANIZE_SENDS` | `false` disables human-like typing/pacing before sends (on by default) |

## Project structure

```
server.js                 # Express app, Baileys, delivery, rate limiting
dev-server.js             # Local UI-only harness (no WhatsApp/R2)
public/                   # Static frontend (en / es / hi / pt) + editor JS
src/server/
  renderEngine.js         # ffmpeg recipe → command (video + audio filter graph)
  encodeExec.js           # encode execution + size-retry tightening
  encodeSemaphore.js      # concurrency limiter (MAX_CONCURRENT_ENCODES)
  recipeValidator.js      # validates edit recipes
  cleanup.js              # R2 / local orphan cleanup
  musicRoutes.js          # music library + mixing routes
  textRaster.js / tgsRaster.js  # text & animated-sticker rasterization
test/                     # node:test + fast-check property tests
```

## Reliability & engineering notes

- **Single WhatsApp session** by design (one linked device) — deployed as a single instance with `WEBSITE_DISABLE_OVERLAPPED_RECYCLING=1` to avoid dual-session conflicts.
- **Timeouts** on every network op (R2 download, message/video send) so a stalled call can't hang delivery.
- **Self-healing**: stuck `processing` jobs auto-recover; failed sends reset to retryable while keeping the R2 file so users can resend.
- **Storage hygiene**: a periodic sweeper purges orphaned R2 objects, skipping live sessions.
- **Human-paced sends**: Gaussian-jittered delays + typing/recording presence before sends.

## Limitations (honest)

Delivery uses **Baileys**, an unofficial WhatsApp integration. WhatsApp
periodically restricts numbers used for automation — a known constraint for this
entire category of tools. The official WhatsApp Cloud API avoids bans but
re-compresses media through its Business pipeline, which defeats the HD goal, so
this project uses Baileys for quality and is architected for fast recovery when
a number is flagged. If you self-host, use a dedicated number you can rotate.

## Contributing

Issues and PRs are welcome. Please run `npm test` before submitting.

## License

**GNU AGPL-3.0-or-later** — see [LICENSE](./LICENSE). If you run a modified
version as a network service, the AGPL requires you to make your modified source
available to its users.
