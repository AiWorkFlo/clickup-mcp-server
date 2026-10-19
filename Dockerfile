FROM node:24.19.0-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --include=dev --ignore-scripts --no-audit
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY test ./test
RUN npm test && npm prune --omit=dev --ignore-scripts --no-audit

FROM node:24.19.0-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=10000
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/build ./build
COPY --from=build --chown=node:node /app/scripts ./scripts
COPY --from=build --chown=node:node /app/package.json ./package.json
USER node
EXPOSE 10000
HEALTHCHECK --interval=20s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:10000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "scripts/coolify-start.mjs"]
