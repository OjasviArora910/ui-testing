# Playwright base image ships Chromium + all system libraries. Keep its version in sync with package.json.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

WORKDIR /app
ENV NODE_ENV=production \
    QA_NO_SANDBOX=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json package-lock.json ./
# Dev dependencies are needed at runtime (tsx) and for the dashboard build.
RUN npm ci --include=dev

COPY tsconfig.json qa.config.json ./
COPY src ./src
COPY demo-app ./demo-app
COPY web ./web
RUN npx vite build web

# Data (SQLite, evidence, reports, baselines) lives in a volume.
VOLUME ["/app/data"]
EXPOSE 4000

# Bind to 0.0.0.0 inside the container; publish the port only to localhost on the host (see docker-compose.yml).
CMD ["npx", "tsx", "src/cli.ts", "serve", "--host", "0.0.0.0", "--port", "4000"]
