# syntax=docker/dockerfile:1.7
# ---- build: install all deps, generate the Prisma client, bundle ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY prisma ./prisma
COPY prisma.config.ts tsconfig.json tsup.config.ts ./
RUN DATABASE_URL=postgresql://build@localhost/build npx prisma generate
COPY src ./src
RUN npm run build

# ---- runtime: production deps only, non-root ----
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY prisma ./prisma
COPY prisma.config.ts ./
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:4000/health/live || exit 1
# Same image runs the worker: `node dist/worker.js`. Migrations run as a release step:
# `npx prisma migrate deploy` (prisma CLI is a dev dep → run it from the build stage / CI).
CMD ["node", "dist/server.js"]
