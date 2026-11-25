# Self-hosting the StatusDrop backend

The backend receives finished clips from the Android app, checks them, stores them briefly in Cloudflare R2, and delivers them over WhatsApp through Baileys linked devices. It doesn't compress video; the app does that on the phone.

**Before you start:** Baileys is an unofficial WhatsApp library. Use a dedicated WhatsApp number, and expect that WhatsApp can disconnect, restrict or ban it.

## Requirements

- Node.js 24 (the Docker image uses `node:24-bookworm-slim`) and npm
- A Cloudflare R2 bucket with an S3 API key, and a public URL the server can download clips from
- One or two WhatsApp numbers to link as devices
- A bare `ffmpeg` command on `PATH`. Baileys uses it to make video thumbnails and metadata; without it WhatsApp re-encodes clips when they're forwarded to Status. The Docker image adds it.

## Run locally

```bash
git clone https://github.com/Shamanthnp1/WAstatus.git
cd WAstatus
npm ci
npm test      # backend test suite
npm start     # http://localhost:3000
```

Put the settings below in a `.env` file or in your host's app settings. Never commit `.env`, R2 keys or the WhatsApp login folders.

## Environment variables

### Required

| Variable | Purpose |
|---|---|
| `R2_ENDPOINT` | Cloudflare R2 S3-compatible endpoint |
| `R2_ACCESS_KEY_ID` | R2 access key |
| `R2_SECRET_ACCESS_KEY` | R2 secret key |
| `R2_BUCKET_NAME` | Bucket for short-lived clips |
| `R2_PUBLIC_URL` | Base URL the server downloads clips from before sending them |
| `WHATSAPP_BUSINESS_NUMBER` | First WhatsApp number in international format, for example `+9198XXXXXXXX` |

### WhatsApp lines

| Variable | Purpose |
|---|---|
| `BAILEYS_AUTH_DIR` | Login folder for the first number; defaults to `baileys_auth`. Must survive restarts |
| `RESET_BAILEYS` | Set to `true` for one start to clear the first number's login and print a new pairing code, then set it back to `false` |
| `WHATSAPP_BUSINESS_NUMBER_2` | Optional second number. New activation codes are spread across connected numbers |
| `BAILEYS_AUTH_DIR_2` | Login folder for the second number; defaults to `<BAILEYS_AUTH_DIR>_2`. Must also survive restarts |
| `RESET_BAILEYS_2` | Same as `RESET_BAILEYS`, for the second number |
| `WHATSAPP_BUSINESS_NUMBER_3`, `BAILEYS_AUTH_DIR_3`, `RESET_BAILEYS_3` | Optional third number, same as the second (login folder defaults to `<BAILEYS_AUTH_DIR>_3`). New activation codes rotate across all connected numbers |
| `WA_LEASE_FILE` | Handover lease that stops two containers connecting the same WhatsApp login during a restart. Defaults to `.statusdrop-wa-lease.json` next to the first login folder (`/home` on Azure, shared by old and new containers). A new server connects as soon as the old one releases it on shutdown, or 20 s after the old one stops refreshing it |
| `WA_START_DELAY_MS` | Optional extra wait before trying to take the lease; default `0` |
| `WHATSAPP_ENABLED` | Set to `false` to stop this server connecting any number while it keeps serving HTTP (for example during a server move). App uploads answer `503` meanwhile |
| `HUMANIZE_SENDS` | Set to `false` to turn off typing/recording presence and pauses before sends |

### Other

| Variable | Purpose |
|---|---|
| `PORT` | HTTP port; defaults to `3000` |
| `WEBHOOK_VERIFY_TOKEN` | Token for the optional Meta webhook check at `GET /webhook` |
| `META_APP_SECRET` | Enables signature checks on `POST /webhook`; without it they're skipped |
| `WHATSAPP_TOKEN`, `WHATSAPP_BUSINESS_ID`, `WHATSAPP_PHONE_ID`, `GRAPH_API_VERSION` | Used only by `npm run subscribe:webhook` |
| `MAX_CONCURRENT_ENCODES`, `FPS_CAP` | Settings for the retired web compressor's encoder |

Without the Cloud API line below, the Meta webhook is receive-only. It logs events and doesn't send anything; delivery always goes through Baileys.

### WhatsApp Cloud API line (optional)

A number registered on Meta's official Cloud API can deliver next to the Baileys numbers. Users reach it through the same wa.me link. Their message arrives at `POST /webhook`, and the clips are uploaded to Meta and sent with the Graph API. Clips over 16 MB, such as 90-second 1080p ones, go as a document.

| Variable | Purpose |
|---|---|
| `WHATSAPP_CLOUD_TOKEN` | Permanent System User access token with `whatsapp_business_messaging` |
| `WHATSAPP_CLOUD_PHONE_NUMBER_ID` | The number's Phone number ID (not the WhatsApp Business Account ID) |
| `WHATSAPP_CLOUD_NUMBER` | The number with country code; the server checks that the Phone number ID matches it |
| `META_APP_SECRET` | Required for this line: a webhook message now triggers a delivery, so unsigned POSTs must be refused |
| `WHATSAPP_CLOUD_ENABLED` | Set to `false` to keep the line off without removing the settings |
| `CLOUD_MONTHLY_MESSAGE_BUDGET` | Most messages the line sends per month; default `950`, inside Meta's 1,000 free. Raise it to allow paid messages |
| `CLOUD_DAILY_MESSAGE_BUDGET` | `auto` (default) spreads what's left of the month evenly over the remaining days; a number is a fixed daily cap; `off` uses the monthly budget only |
| `CLOUD_BUDGET_TZ` | Timezone for months and days; default `Asia/Kolkata`. Use your Messaging account's timezone, because Meta resets the free tier at midnight there |
| `CLOUD_USAGE_FILE` | Where the counts are kept; default `.statusdrop-cloud-usage.json` next to the login folders |
| `WHATSAPP_CLOUD_WABA_ID` | Optional. Normally learned from the first webhook; used to compare the counts with Meta's |

When the budget is full, the line shows `paused`, app uploads get "try again later", and extra replies are skipped. A delivery report or Meta usage figure that shows a billed message also pauses it for the rest of the month. Each delivery costs one message per clip: the verified note rides on the first clip's caption. Deliveries are counted per country calling code (never full numbers) in the usage file and logs.

The line shows as `cloud` in `/api/health`. A Baileys line with the same number is never started. `WHATSAPP_ENABLED=false` stops the Baileys lines only. Point the Meta app's webhook at `https://<your server>/webhook` and subscribe to the `messages` field. Meta's free tier covers 1,000 service messages per number each month; each delivery uses one text plus one message per clip.

## Link the WhatsApp numbers

On first start the logs print a pairing code for each number that isn't linked yet, labelled `line1` or `line2`.

1. On that phone, open WhatsApp → **Settings → Linked devices → Link a device**.
2. Tap **Link with phone number instead** and enter the **newest** code from the logs. Each code lasts a couple of minutes; while the number is unlinked, a fresh one is printed about a minute after the last one expires.
3. Keep the login folders on persistent storage.

Check `GET /api/health`:

```json
{
  "baileys": "connected",
  "whatsappLines": [
    { "line": "line1", "status": "connected" },
    { "line": "line2", "status": "connected" }
  ]
}
```

`baileys` is `connected` while at least one number can deliver, including the Cloud API line. Each line shows `connected`, `disconnected`, `stopped`, `not_linked` or `disabled`. Phone numbers are never included.

## API

| Route | Purpose |
|---|---|
| `GET /api/health` | Server and WhatsApp status |
| `POST /api/mobile/sessions` | App starts an upload; returns a bearer token and one upload URL per clip |
| `PUT /api/mobile/sessions/:sessionId/clips/:order` | App uploads one finished clip |
| `POST /api/mobile/sessions/:sessionId/finalize` | Creates the activation code and WhatsApp link |
| `GET`, `POST /webhook` | Optional Meta webhook |

Web compressor routes (`/api/upload-url`, `/api/process`, `/api/job`, `/api/library`, `/api/music`) answer `410 Gone`.

Each upload is checked against its declared size and SHA-256, then ffprobed: MP4 with one H.264 `yuv420p` video stream at the selected profile's size, up to 30 fps, optional AAC audio, and the expected duration. Limits are 20 clips, 15.8 MB per clip and 300 MB per upload. Upload sessions expire after 10 minutes without activity and after 1 hour at most. Session and finalize requests are limited to 200 per IP address per day. While no WhatsApp number is connected, these routes answer `503` so the app keeps its clips and the user can retry.

## Deploying

The production setup is a Docker image on Azure App Service (Linux, B1 is enough) with the website on Vercel.

- **Build:** every push to `main` runs [`deploy-azure.yml`](.github/workflows/deploy-azure.yml), which builds the image and publishes it as `ghcr.io/shamanthnp1/wastatus:latest` and a commit-SHA tag.
- **Deploy:** if the repository secret `AZURE_WEBHOOK` holds the App Service continuous-deployment webhook URL, the workflow pings it and App Service pulls the new image.
- **Skipped pushes:** pushes that only change docs, `mobile/`, `public/` or the release workflow don't deploy, because each deploy restarts the server and takes WhatsApp offline for 1–2 minutes.
- **Storage:** on Azure, set `WEBSITES_ENABLE_APP_SERVICE_STORAGE=true` and keep the login folders under `/home` (for example `/home/baileys_auth`) so they survive restarts.
- **One server only:** run a single instance. Two servers using the same WhatsApp login knock each other off and risk a logout. To move servers, set `WHATSAPP_ENABLED=false` on the old one, wait for it to stop, copy both login folders, then start the new one.
- **Not persisted:** activation codes and upload sessions live in memory, so a restart loses codes that haven't been redeemed yet.

## Cleanup

Delivered clips are deleted from R2 after a successful send or when the 5-minute activation code expires. Startup and periodic sweeps remove leftover local temp files and R2 objects older than 30 minutes that no live session owns. Cleanup is best effort, so restarts or storage errors can keep files a little longer.
