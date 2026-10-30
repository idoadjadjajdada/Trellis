# ---- Build ---------------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

# ---- Run -----------------------------------------------------------------
FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PORT=3000 \
    MODEL_CACHE_DIR=/models
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
RUN mkdir -p /models && chown node:node /models
USER node
# Bake the embedding model (about 130 MB) into the image: hosts like Render have no disk by
# default, and downloading it on every start could push a 512 MB instance out of memory.
RUN node --input-type=module -e "import {loadConfig} from './dist/server/config.js'; import {createEmbedder} from './dist/server/embeddings.js'; await createEmbedder(loadConfig()).warmUp?.(); process.exit(0)"
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://localhost:3000/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "dist/server/index.js"]
