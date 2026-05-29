FROM node:20-bullseye-slim

# Install ca-certificates for HTTPS
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first (better layer caching)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy app source
COPY . .

# Make required runtime folders
RUN mkdir -p uploads compressed

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server.js"]
