# --- Stage 1: base (install deps) ---
FROM node:24-alpine AS base
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY packages/common/package.json packages/common/
COPY apps/backend/package.json apps/backend/
COPY apps/webpage/package.json apps/webpage/
RUN pnpm install --frozen-lockfile

# --- Stage 2: build-common ---
FROM base AS build-common
COPY packages/common/ packages/common/
RUN pnpm --filter @cuttlekit/common build

# --- Stage 3: build-backend ---
FROM build-common AS build-backend
COPY apps/backend/ apps/backend/
RUN pnpm --filter @cuttlekit/backend build
RUN pnpm deploy --filter @cuttlekit/backend --prod /app/deployed

# --- Stage 4: build-webpage ---
FROM build-common AS build-webpage
ARG VITE_API_BASE="http://localhost:34512"
ENV VITE_API_BASE=${VITE_API_BASE}
COPY apps/webpage/ apps/webpage/
RUN pnpm --filter @cuttlekit/webpage build

# --- Stage 5: backend runtime ---
FROM node:24-alpine AS backend
RUN apk add --no-cache tini
WORKDIR /app
COPY --from=build-backend /app/deployed/node_modules/ ./node_modules/
COPY --from=build-backend /app/apps/backend/dist/ ./dist/
COPY config.toml ./
COPY drizzle/ ./drizzle/
RUN mkdir -p /app/data && chown node:node /app/data
ENV DATABASE_URL=file:/app/data/memory.db
USER node
EXPOSE 34512
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.mjs"]

# --- Stage 6: webpage runtime ---
FROM node:24-alpine AS webpage
RUN npm i -g serve
WORKDIR /app
COPY --from=build-webpage /app/apps/webpage/dist/ ./dist/
USER node
EXPOSE 34513
CMD ["serve", "-s", "dist", "-l", "34513"]
