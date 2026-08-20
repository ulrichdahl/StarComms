# syntax=docker/dockerfile:1

# Debian, never Alpine: @snazzah/davey (DAVE), @discordjs/opus and later
# better-sqlite3 are native modules and musl breaks them. Spec §13.
ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS base
ENV NODE_ENV=production
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS deps
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential python3 \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm install --include=dev

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM base AS runtime
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
EXPOSE 3000
CMD ["node", "dist/spike/receive.js"]

# Dev target: full toolchain, sources mounted by the compose override.
# Exec tsx directly (not `npm run`) so SIGTERM reaches the Node process and its
# shutdown handler prints the verdict on `docker compose down`.
FROM deps AS dev
ENV NODE_ENV=development
COPY tsconfig.json ./
EXPOSE 3000
CMD ["./node_modules/.bin/tsx", "src/spike/receive.ts"]
