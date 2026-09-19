# Generated for Smithery deployment
FROM node:22-alpine AS builder

WORKDIR /app

# Copy dependency manifests
COPY package*.json tsconfig.json ./

# Install dependencies for compilation
RUN npm ci

# Copy source code and compile TypeScript
COPY src ./src
RUN npm run build

# Production release image
FROM node:22-alpine AS release

WORKDIR /app

# Install ffmpeg for automatic audio compression support
RUN apk add --no-cache ffmpeg

# Copy build artifacts and dependencies
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/build ./build

# Install only production dependencies
RUN npm ci --omit=dev

ENTRYPOINT ["node", "build/index.js"]
