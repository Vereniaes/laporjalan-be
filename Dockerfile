# Stage 1: Build TypeScript
FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Stage 2: Production Runner for Cloud Run
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

COPY package*.json ./
RUN alpine_version="$(cut -d. -f1,2 /etc/alpine-release)" \
    && apk --no-cache --timeout 10 --repositories-file /dev/null \
       -X "https://dl-5.alpinelinux.org/alpine/v${alpine_version}/main" \
       -X "https://dl-5.alpinelinux.org/alpine/v${alpine_version}/community" add ffmpeg \
    && npm ci --omit=dev

COPY --from=builder /app/dist ./dist

# Create uploads folder for local fallback
RUN mkdir -p uploads && chown -R node:node /app

USER node

EXPOSE 8080

CMD ["node", "dist/index.js"]
