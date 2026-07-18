# WAstatus (StatusDrop)

A free tool for creating **HD WhatsApp Status videos**. Users upload and edit a
clip in the browser; the server compresses it to a WhatsApp-status-friendly
spec, splits long videos into parts, and delivers the finished clips straight to
the user's WhatsApp chat so they can forward them to their Status in full
quality.

Live at **[wastatusvideo.com](https://wastatusvideo.com)**.

---

## How it works

```
Browser (editor)  ──►  Cloudflare Worker  ──►  Cloudflare R2 (object storage)
       │                                              ▲
       │  /api/process (recipe + R2 keys)             │ pull source
       ▼                                              │
   Backend API (Node/Express)  ──►  ffmpeg encode/split  ──►  upload outputs to R2
       │
       │  user messages the WhatsApp number with their reference code
       ▼
   Baileys (WhatsApp)  ──►  sends the HD clips to the user's chat
```

- **Frontend** — static site in `public/` (multi-language: en/es/hi/pt), an
  in-browser video editor, deployed on Vercel.
- **Backend** — `server.js` (Express) running in a Docker container on Azure
  App Service. Handles uploads, ffmpeg compression/splitting, and WhatsApp
  delivery.
- **Storage** — Cloudflare R2 (S3-compatible) for source uploads and rendered
  output clips. A background sweeper purges orphaned objects.
- **WhatsApp delivery** — [Baileys](https://github.com/WhiskeySockets/Baileys)
  multi-device library. Users message a business number with a short reference
  code; the bot replies with the processed clips.
- **Encoding** — `ffmpeg-static` / `ffprobe-static`, with a default 1080p/30s
  profile and an optional 720p/up-to-60s "longer clips" mode.

## Tech stack

Node.js 20 · Express 5 · Baileys · ffmpeg · Cloudflare R2 (AWS SDK v3) ·
`@napi-rs/canvas` (text/sticker rasterization) · Docker · Vercel · Azure App
Service.

## Local development

> Requires Node.js 20+.

```bash
npm install

# Run the tests (node:test + fast-check property tests)
npm test

# Start the full server (needs the environment variables below)
npm start
```

There is also a local dev harness (`dev-server.js`) for testing the editor UI
without Baileys, R2, or WhatsApp.

## Environment variables

Create a `.env` file (it is git-ignored — **never commit secrets**):

| Variable | Purpose |
|----------|---------|
| `PORT` | HTTP port (defaults to `3000`). |
| `R2_ENDPOINT` | Cloudflare R2 S3 endpoint. |
| `R2_ACCESS_KEY_ID` | R2 access key. |
| `R2_SECRET_ACCESS_KEY` | R2 secret key. |
| `R2_BUCKET_NAME` | R2 bucket name. |
| `R2_PUBLIC_URL` | Public base URL for R2 objects. |
| `WHATSAPP_BUSINESS_NUMBER` | Business number in full international format (e.g. `+9198XXXXXXXX`). |
| `MAX_CONCURRENT_ENCODES` | Max simultaneous ffmpeg jobs (e.g. `3`). |
| `BAILEYS_AUTH_DIR` | Directory for the persisted WhatsApp session (e.g. `/home/baileys_auth`). |
| `RESET_BAILEYS` | Set `true` once to wipe the session and re-link via pairing code, then set back to `false`. |
| `HUMANIZE_SENDS` | `false` disables the human-like typing/pacing before sends (on by default). |

## Deployment

- The frontend deploys automatically to **Vercel** from `public/`.
- The backend builds a Docker image via GitHub Actions
  (`.github/workflows/deploy-azure.yml`), pushes it to GHCR, and Azure App
  Service pulls it. Because a single WhatsApp session must run at a time, the
  app runs as a **single instance** with `WEBSITE_DISABLE_OVERLAPPED_RECYCLING=1`.

## Contributing

Issues and pull requests are welcome. Run `npm test` before submitting.

## License

Licensed under the **GNU Affero General Public License v3.0 (or later)** — see
[LICENSE](./LICENSE). If you run a modified version as a network service, the
AGPL requires you to make your modified source available to its users.
