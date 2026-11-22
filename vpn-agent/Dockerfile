ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE} AS build
USER root
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM ${NODE_IMAGE} AS runtime
USER root
ENV NODE_ENV=production
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates iproute2 nftables wireguard-tools dumb-init \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
RUN install -d -o node -g node -m 0700 /state
ENTRYPOINT ["dumb-init", "--", "setpriv", "--reuid", "1000", "--regid", "1000", "--init-groups", "--inh-caps", "+net_admin", "--ambient-caps", "+net_admin", "--bounding-set", "-setuid,-setgid,-setpcap", "--no-new-privs"]
CMD ["node", "dist/main.js"]

