FROM node:20-alpine
WORKDIR /app

# Root workspace deps
COPY package.json package-lock.json ./

# Workspace package manifests (required for npm install to resolve file: links)
COPY packages/lib/package.json packages/lib/package.json
COPY services/ingest/package.json services/ingest/package.json

# Install all workspace dependencies
RUN npm install --no-audit --no-fund

# Copy source code
COPY packages/lib/src/ packages/lib/src/
COPY services/ingest/src/ services/ingest/src/

EXPOSE 3001

WORKDIR /app/services/ingest
CMD ["node", "src/index.js"]
