FROM node:20-alpine
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/lib/package.json packages/lib/package.json
COPY services/flaky-endpoint-test-server/package.json services/flaky-endpoint-test-server/package.json

RUN npm install --no-audit --no-fund

COPY packages/lib/src/ packages/lib/src/
COPY services/flaky-endpoint-test-server/ services/flaky-endpoint-test-server/

EXPOSE 9099

WORKDIR /app/services/flaky-endpoint-test-server
CMD ["node", "index.js"]
