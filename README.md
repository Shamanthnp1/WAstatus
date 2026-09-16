<div align="center">

# 📲 StatusDrop (WAstatus)

**Prepare and deliver WhatsApp Status videos using a profile tuned through real-device testing.**

StatusDrop compresses and splits videos in the cloud and sends the finished clips directly to the same WhatsApp account that requests them. This README documents the posting sequence that has preserved quality in manual phone testing.

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20.x-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#contributing)

🌐 **[wastatusvideo.com](https://www.wastatusvideo.com)**

</div>

---

## Important: tested HD posting workflow

Do **not** forward the original bot message directly to Status. The workflow that has preserved the delivered file's quality in testing is:

1. Request and receive the processed video **directly from StatusDrop** in the same WhatsApp account that will post it.
2. Open the bot-delivered video and tap **Download/Save**.
3. On that same phone and account, use **📎 → Gallery** to send the saved file into any chat. **Message yourself** is convenient.
4. Select **HD quality** in WhatsApp's send preview. Add the desired Status caption there, then send.
5. On that **newly sent copy**, choose **Forward → My Status** and post it.
6. Do not edit or trim the video again in WhatsApp, and keep the downloaded source until posting is complete.

### Manual phone observations

These observations were recorded during development from a narrow set of manual tests. File sizes are rounded and video/device/app-version metadata was not recorded, so treat the table as practical evidence for the workflow—not as a reproducible laboratory study or a universal WhatsApp rule.

| Path tested | Observed result |
|---|---|
| Direct StatusDrop/Baileys delivery to Phone B (9.3 MB) → save → Gallery resend in HD (downloadable chat copy 7.2 MB) → forward the newly sent copy | Status download remained about 9.3 MB and looked sharp |
| Transfer the same 9.3 MB MP4 to Phone B with Quick Share → Gallery resend in HD (7.2 MB chat copy) → forward | Status became about 4.0 MB and looked blurry |
| Forward the bot media through WhatsApp to another phone, then resend and post there | The receiving phone got a smaller derivative and the Status remained degraded |
| Forward the original bot message directly to Status | WhatsApp visibly processed/re-encoded it and quality dropped |

These observations show that **direct delivery provenance and the Gallery-resend step both mattered in the tested flow**. They do not reveal the internal cause. WhatsApp does not publicly document the relevant consumer Status transcoding, forwarding, cache, or media-association rules, so StatusDrop does not claim that any particular media key, database entry, metadata field, or server flag is responsible. WhatsApp can change this behavior at any time.

## What StatusDrop does

- Accepts up to **3 videos / 300 MB total** per request.
- Supports common ffmpeg-readable formats, including MP4, MOV, AVI, MKV, 3GP, WMV, WebM, M4V, MPEG/MPG, FLV, TS/MTS and M2TS.
- Uses a tested default profile targeting **1080 × 1920 H.264/AAC** output and approximately **29-second** parts.
- Offers an optional **720 × 1280 / approximately 59-second** mode for fewer, longer parts.
- Uploads files directly from the browser to Cloudflare storage through an upload Worker, including multipart uploads for large files.
- Runs processing as a background job and polls for completion, so switching apps or temporarily losing the browser connection does not stop the server encode.
- Returns a short-lived activation code and delivers all output clips to the WhatsApp account that sends that code.
- Requires no StatusDrop login and adds no watermark.

The public website intentionally focuses on compression and delivery without video-editing controls. The interface is currently English-only.

## User flow

1. Select up to three videos.
2. Choose the default 1080p profile or the 720p longer-clips profile.
3. The browser obtains upload URLs from `POST /api/upload-url` and uploads media directly through the external Cloudflare Worker.
4. The frontend starts `POST /api/process` with `async: true`, receives a job ID, and polls `GET /api/job/:jobId` while the backend downloads, validates, renders, compresses, splits, and uploads the results.
5. StatusDrop returns a nine-character activation code and a WhatsApp deep link. The code is valid for approximately five minutes.
6. The user sends the prefilled code from the WhatsApp account that should receive the video. Baileys uses the sender identity from that message; the website does not ask for a destination phone number.
7. The bot sends all clips directly to that account.
8. The user follows the [tested HD posting workflow](#important-tested-hd-posting-workflow).

## Architecture

```text
┌────────────────────────────┐
│ Static frontend on Vercel  │
│ upload + quality choice    │
└─────────────┬──────────────┘
              │ request upload URL
              ▼
┌────────────────────────────┐       ┌────────────────────────┐
│ External Cloudflare Worker │ ────► │ Cloudflare R2          │
│ direct + multipart upload  │       │ temporary media        │
└────────────────────────────┘       └────────────┬───────────┘
                                                  │ pull source
              ┌───────────────────────────────────┘
              ▼
┌──────────────────────────────────────────────────────────────┐
│ Node/Express backend in Docker on Azure App Service          │
│ validate → ffmpeg render/compress/split → temporary R2 clips │
│ in-memory background JobStore + activation sessions          │
└─────────────────────────────┬────────────────────────────────┘
                              │ activation code received from user
                              ▼
┌────────────────────────────┐
│ Baileys linked-device      │ ───► direct clip delivery to the
│ WhatsApp session           │      same requesting account
└────────────────────────────┘
```

The upload Worker's source and production Cloudflare configuration are not part of this repository. The optional Meta webhook is receive-only: it acknowledges/logs events and does not trigger or replace Baileys delivery.

### Main HTTP endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | Backend, Baileys, bare-ffmpeg and FPS-cap status |
| `POST /api/upload-url` | Validate upload metadata and return a Worker upload URL/key |
| `POST /api/process` | Start processing; async clients receive HTTP 202 and a job ID |
| `GET /api/job/:jobId` | Poll processing, completion or error state |
| `GET /webhook` | Optional Meta webhook verification |
| `POST /webhook` | Receive-only Meta event intake; HMAC-verified when `META_APP_SECRET` is configured |

With no `META_APP_SECRET`, POST signature validation is intentionally skipped and the receive-only endpoint accepts unsigned events. It still has no delivery or session side effects.

Finished job records are stored in process memory for a limited time. Jobs and activation sessions do not survive a backend restart and are not shared across instances.

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | Vanilla HTML/CSS/JavaScript, static deployment on Vercel |
| Backend | Node.js 24, Express 5 |
| Video | ffmpeg/ffprobe via `ffmpeg-static` and `ffprobe-static` |
| Rasterization | `@napi-rs/canvas`, Pako and Lottie infrastructure |
| Storage | Cloudflare R2 through the AWS SDK v3 S3-compatible API |
| Uploads | External Cloudflare Worker |
| WhatsApp delivery | `@whiskeysockets/baileys` multi-device session |
| Hosting | Docker image on Azure App Service; frontend on Vercel |
| Tests | Node's test runner plus `fast-check` property-based tests |

## Getting started

### Requirements

- Node.js 24 (the deployed Docker baseline)
- npm
- Cloudflare R2 credentials and a compatible upload Worker for the full hosted flow
- A WhatsApp account/number for the Baileys linked-device session
- A bare `ffmpeg` command available on `PATH` for full Baileys video metadata/thumbnail handling

The application uses the packaged ffmpeg binary for its own encode pipeline. Baileys also shells out to a command named `ffmpeg`, so local full-delivery setups still need that command on `PATH`. The Docker image creates the required symlink automatically.

### Install and run

```bash
git clone https://github.com/Shamanthnp1/WAstatus.git
cd WAstatus
npm ci

# Run the automated suite once
npm test

# Local static/render development harness (default http://localhost:8080)
node dev-server.js

# Full server (default http://localhost:3000)
npm start
```

There is currently no Docker Compose file and no checked-in `.env.example`.

### Environment variables

Create a local `.env` or configure these values in the deployment platform. Never commit `.env`, R2 credentials, Meta tokens, or Baileys session files.

#### Core full-server configuration

| Variable | Purpose |
|---|---|
| `R2_ENDPOINT` | Cloudflare R2 S3-compatible endpoint |
| `R2_ACCESS_KEY_ID` | R2 access key |
| `R2_SECRET_ACCESS_KEY` | R2 secret key |
| `R2_BUCKET_NAME` | Temporary-media bucket |
| `R2_PUBLIC_URL` | Base URL used by the backend to fetch temporary media |
| `WHATSAPP_BUSINESS_NUMBER` | Linked WhatsApp number in full international format, for example `+9198XXXXXXXX` |

#### Runtime and delivery tuning

| Variable | Purpose |
|---|---|
| `PORT` | HTTP port; defaults to `3000` |
| `DEV_PORT` | Local harness port; defaults to `8080` |
| `BAILEYS_AUTH_DIR` | Persisted Baileys auth directory; defaults to `baileys_auth` |
| `RESET_BAILEYS` | Set to `true` for one boot to clear/relink, then return it to `false` |
| `MAX_CONCURRENT_ENCODES` | Maximum simultaneous ffmpeg encodes |
| `HUMANIZE_SENDS` | Set to `false` to disable delivery pacing/presence behavior |
| `FPS_CAP` | Defaults to `29.97`; use `off` to remove the frame-rate cap |

#### Optional Meta webhook configuration

| Variable | Purpose |
|---|---|
| `WEBHOOK_VERIFY_TOKEN` | Verification token for `GET /webhook` |
| `META_APP_SECRET` | Enables HMAC verification for `POST /webhook`; without it verification is skipped |
| `WHATSAPP_TOKEN` | Token used only by `npm run subscribe:webhook` |
| `WHATSAPP_BUSINESS_ID` | Business ID used by the subscription helper |
| `WHATSAPP_PHONE_ID` | Phone ID used by the subscription helper |
| `GRAPH_API_VERSION` | Optional Graph API version override for the helper |

These Meta variables are not required for Baileys video delivery.

### Link the Baileys session

On the first full-server boot, the logs print a pairing code for `WHATSAPP_BUSINESS_NUMBER`:

1. Open WhatsApp on that phone.
2. Go to **Settings → Linked Devices → Link a Device**.
3. Choose **Link with phone number instead**.
4. Enter the newest pairing code shown in the server logs.
5. Persist `BAILEYS_AUTH_DIR` across restarts and deployments.

If `RESET_BAILEYS=true` was used, set it back to `false` after a successful link or every restart will erase the session again.

## Project structure

```text
server.js                       Express API, processing orchestration, Baileys
src/server/                     Validation, jobs, rendering, cleanup, webhooks
src/shared/constants.js         Shared media/profile limits
dev-server.js                   Local editor + ffmpeg render harness
public/index.html               Production single-page frontend
public/js/                      Legacy rendering modules retained for tests
public/privacy.html             Production privacy disclosure
scripts/subscribe-whatsapp-webhook.js
                                Optional Meta webhook subscription helper
test/                           Unit, property-based and integration-shaped tests
Dockerfile                      Node 24 Azure/GHCR production image
vercel.json                     Static frontend output + old locale redirects
.github/workflows/deploy-azure.yml
                                GHCR build and optional Azure webhook trigger
```

## Deployment

### Frontend

The root `vercel.json` publishes `public/`. Previous `/hi`, `/es` and `/pt` routes permanently redirect to the English homepage.

### Backend

The Dockerfile:

- uses `node:24-bookworm-slim`;
- installs production dependencies with `npm ci --omit=dev`;
- exposes port 3000;
- links the packaged ffmpeg binary to `/usr/local/bin/ffmpeg`; and
- starts `node server.js`.

Pushes to `main` build and publish `ghcr.io/shamanthnp1/wastatus:latest` plus a commit-SHA tag. If the repository secret `AZURE_WEBHOOK` is configured, the workflow asks Azure App Service to pull the new image. The workflow does not provision infrastructure, configure secrets, deploy Vercel, or currently run tests as a deployment gate.

Run the backend as a **single active instance** unless sessions/jobs are moved to shared durable storage. Persist `BAILEYS_AUTH_DIR` on a mounted volume and avoid overlapping instances using the same WhatsApp session.

`baileys_auth/` contains sensitive linked-device credentials. It is git-ignored, but operators performing local Docker builds should also ensure their auth directory is excluded from the Docker build context.

## Reliability and data lifecycle

- The frontend starts processing asynchronously and retries job polling after temporary network failures or mobile app switching.
- ffmpeg work is semaphore-limited and has timeouts plus progressively tighter retries for oversized output.
- Duplicate/stale inbound WhatsApp messages are suppressed, and repeated non-code messages are throttled.
- Failed video sends remain retryable during the activation window instead of immediately deleting their outputs.
- On the normal path, source objects are removed after backend download; delivered outputs are removed after successful sending or session expiry.
- Startup and periodic sweepers clean stale local and R2 artifacts while avoiding known live requests/sessions.

Cleanup is **best effort**, not a cryptographic or hard real-time deletion guarantee. Restarts, storage/API failures and orphan-sweeper timing can extend retention beyond the normal five-minute activation window. The service also processes technical logs, IP addresses for rate limiting, and the WhatsApp sender identity needed for delivery.

The hosted [Privacy Policy](https://www.wastatusvideo.com/privacy.html) provides user-facing disclosures. Operators must keep their own policy aligned with actual storage, logging and cleanup behavior; hard deletion deadlines should not be promised when cleanup is best effort.

The production frontend uses Google Analytics and includes the Google AdSense publisher loader; advertising availability depends on the site's AdSense status and configuration.

## Testing

Run:

```bash
npm test
```

The suite includes unit, property-based and integration-shaped coverage for:

- input limits, MIME/extension handling and recipe validation;
- editor trim/text/sticker/audio state;
- recipe routing, chunk planning and audio continuity;
- ffmpeg command construction, timeouts, retries and encode concurrency;
- R2/local cleanup ledgers, orphan sweeps and delivery teardown;
- in-memory job lifecycle and expiry;
- WhatsApp replay, duplicate and welcome-message guards;
- Meta webhook verification/signature handling; and
- text/TGS rasterization and output conformance.

Network services and Baileys are mocked in relevant integration tests. Job tests exercise the `JobStore`, not the production HTTP handoff/browser polling path. Delivery tests do not execute the real inbound JID-routing handler. The suite does **not** automate real WhatsApp Status posting or guarantee future HD behavior; the device workflow above is based on manual observations.

## Limitations and disclaimer

- StatusDrop is independent and is not affiliated with, endorsed by, or supported by WhatsApp or Meta.
- Delivery uses the unofficial Baileys library and a linked-device session, not an official WhatsApp sending API.
- WhatsApp can change its protocol/media behavior, disconnect linked devices, restrict automated accounts or invalidate the tested workflow without notice.
- Use a dedicated WhatsApp account/number when self-hosting and accept the account and maintenance risk.
- HD preservation is an empirical result, not a guarantee. Device, OS, WhatsApp version, account rollout and future server changes may affect it.
- The internal reason direct bot delivery behaves differently from Quick Share or forwarded cross-phone media is undocumented.
- Processing jobs and activation sessions are in memory and are lost on backend restart.
- The current deployment assumes one active backend instance and one Baileys session.
- Default limits are three videos and 300 MB total; the activation code expires after approximately five minutes.
- The public website intentionally provides compression and delivery only, without video-editing controls.
- The upload Worker and production cloud configuration are maintained outside this repository.

## Contributing

Issues and pull requests are welcome. Please keep user-facing quality claims evidence-based and run `npm test` before submitting a change.

## License

StatusDrop is licensed under **GNU AGPL-3.0-or-later**. See [LICENSE](./LICENSE) for the complete terms.
