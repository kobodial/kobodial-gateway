# --- build -------------------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app

# better-sqlite3 ships prebuilt binaries for common platforms but falls
# back to compiling from source, so the toolchain has to be present in
# the build stage (it is deliberately absent from the runtime stage).
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Dependencies first, as their own layer: they only need reinstalling
# when the lockfile actually changes, not on every source edit.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Drop dev dependencies from the tree that gets copied forward.
RUN npm prune --omit=dev

# --- runtime -----------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
# Migrations are read at runtime by server.ts, from source rather than
# from dist — they are .sql files, not compiled output.
COPY src/db/migrations ./src/db/migrations

# node's own unprivileged user, rather than root. The SQLite file lives
# in /data so a volume can be mounted there without the app needing
# write access to its own code.
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]

ENV DATABASE_URL=file:/data/kobodial-gateway.sqlite
ENV PORT=3000
EXPOSE 3000

# No HEALTHCHECK curl here — the image ships no curl, and the platform
# hitting GET /health is the check that actually matters.
CMD ["node", "dist/server.js"]
