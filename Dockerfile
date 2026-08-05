FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY extension ./extension
RUN npm run build \
    && apt-get update \
    && apt-get install -y --no-install-recommends zip \
    && cd extension \
    && zip -qr /app/extension.zip . \
    && rm -rf /var/lib/apt/lists/*

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/extension.zip ./extension.zip
COPY --from=build /app/extension/manifest.json ./extension/manifest.json
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "--experimental-sqlite", "dist/src/server.js"]
