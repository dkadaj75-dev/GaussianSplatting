# SplatScene web client — development image (Vite dev server with HMR).
#
# Infra only (owned by WP 0.4): nothing under web/src is touched here. The dev
# server is the compose-referenced target because the local stack's purpose is
# iterating on the viewer; a production image would instead run
# `npm run build` and serve web/dist from nginx.
#
# Build from the repo root:  docker build -t splatscene-web ./web
FROM node:22-slim

ENV NODE_ENV=development \
    CI=true

WORKDIR /srv/web

# Manifests first so the (slow) install layer caches across source changes.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Vite dev server; --host makes it reachable from outside the container.
EXPOSE 5173
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "5173"]
