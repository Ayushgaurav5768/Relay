FROM node:20-alpine
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/lib/package.json packages/lib/package.json
COPY services/delivery-worker/package.json services/delivery-worker/package.json

RUN npm install --no-audit --no-fund

COPY packages/lib/src/ packages/lib/src/
COPY services/delivery-worker/src/ services/delivery-worker/src/

EXPOSE 3002

WORKDIR /app/services/delivery-worker
CMD ["node", "src/index.js"]
