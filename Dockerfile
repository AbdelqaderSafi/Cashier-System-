# ─── Stage 1: Build ───────────────────────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app

# Copy all source files
COPY . .

# Install dependencies (postinstall → prisma generate)
RUN npm install

# Compile TypeScript → dist/
RUN npm run build

# Verify dist was created — fails the build if missing
RUN test -f dist/main.js && echo "✔ dist/main.js found" || (echo "✘ dist/main.js NOT found!" && ls -la dist/ 2>/dev/null || echo "dist/ does not exist" && exit 1)


# ─── Stage 2: Run ─────────────────────────────────────────────────────────────
FROM node:20-slim AS runner

# Install Chromium and system libraries (Debian Bookworm packages)
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    libnspr4 \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libdbus-1-3 \
    libxkbcommon0 \
    libatspi2.0-0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    ca-certificates \
    fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV NODE_ENV=production

WORKDIR /app

# Copy only what the running app needs
COPY --from=builder /app/dist          ./dist
COPY --from=builder /app/node_modules  ./node_modules
COPY --from=builder /app/generated     ./generated
COPY --from=builder /app/prisma        ./prisma
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts
COPY --from=builder /app/package.json  ./package.json
COPY --from=builder /app/assets        ./assets

EXPOSE 3000

CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main"]
