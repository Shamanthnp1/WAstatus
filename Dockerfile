FROM node:20-bullseye-slim

# Install ca-certificates (HTTPS) and libfontconfig1 (font support for
# @napi-rs/canvas text rasterization on the slim Debian image).
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ca-certificates \
      libfontconfig1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first (better layer caching)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy app source
COPY . .

# Baileys builds video thumbnails by shelling out to a BARE `ffmpeg` command
# (see @whiskeysockets/baileys Utils/messages-media.js -> extractVideoThumb).
# We already ship the ffmpeg-static binary and point fluent-ffmpeg at it by
# absolute path, but Baileys can't see that — so without this symlink the
# thumbnail step fails silently and outgoing video messages carry no
# jpegThumbnail / dimensions / duration, unlike a real WhatsApp client.
# Symlink rather than apt-installing a second ffmpeg copy.
RUN ln -sf "$(node -p 'require("ffmpeg-static")')" /usr/local/bin/ffmpeg \
    && ffmpeg -version | head -n 1

# Make required runtime folders
RUN mkdir -p uploads compressed

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server.js"]
