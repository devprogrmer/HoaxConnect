FROM node:22-bookworm-slim AS dependencies

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS build

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS production-dependencies

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV NODE_OPTIONS=--max-old-space-size=192

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates dumb-init \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY migrations ./migrations
COPY scripts ./scripts

# A checkout created with umask 077 must still be readable by the runtime user.
RUN chmod -R a+rX /app/dist /app/migrations /app/scripts \
    && chmod a+r /app/package.json

USER node

ENTRYPOINT ["dumb-init", "--"]
CMD ["sh", "-c", "node dist/migrate.js && node dist/server.js"]
