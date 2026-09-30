# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# ---- dev: source is bind-mounted ----
FROM base AS dev
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
EXPOSE 3000
CMD ["sh", "-c", "npm install --no-audit --no-fund && npm run dev"]

# ---- build ----
FROM base AS build
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
ARG API_INTERNAL_URL=http://api:4000
ARG MEDIA_ORIGIN=https:
ENV API_INTERNAL_URL=$API_INTERNAL_URL MEDIA_ORIGIN=$MEDIA_ORIGIN
RUN npm run build

# ---- prod ----
FROM base AS prod
ENV NODE_ENV=production
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
USER node
EXPOSE 3000
CMD ["node", "server.js"]
