# Serve the app under a path such as /draw instead of at the root:
#   docker build --build-arg BASE_PATH=/draw .
# It is baked into the frontend at build time and handed to the server as is,
# so the two always match.
ARG BASE_PATH=""

# An exact version, not just "22": the server uses Node's built-in SQLite,
# which is still marked experimental and may change between releases. With
# this, rebuilding the image gives the same Node every time. Raise it on
# purpose, for security fixes, and run the tests on the new version first.
ARG NODE_VERSION=22.23.5

# Debian rather than Alpine: on some older kernels (CentOS 7, for one) SQLite
# under Alpine's musl fails every write with "disk I/O error".

# --- Build the frontend ---
FROM node:${NODE_VERSION}-bookworm-slim AS build
ARG BASE_PATH
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN BASE_PATH="$BASE_PATH" npm run build

# --- Runtime: one Node process serves the API and the built frontend ---
FROM node:${NODE_VERSION}-bookworm-slim
ARG BASE_PATH
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    BASE_PATH=${BASE_PATH}
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY --from=build /app/dist ./dist
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
# The server answers with or without BASE_PATH in front, so this needs no prefix.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT}/api/health`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
