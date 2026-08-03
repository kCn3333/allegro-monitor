FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim
ENV NODE_ENV=production PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev \
    && npx playwright install --with-deps chromium \
    && apt-get update \
    && apt-get install -y --no-install-recommends xauth \
    && command -v xvfb-run \
    && command -v xauth \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/dist ./dist
RUN mkdir -p /app/data /app/browser-profile && chown -R node:node /app/data /app/browser-profile
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["xvfb-run", "-a", "--server-args=-screen 0 1365x768x24", "node", "--experimental-sqlite", "dist/src/server.js"]
