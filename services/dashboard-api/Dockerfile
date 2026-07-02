FROM node:20-alpine
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/lib/package.json packages/lib/package.json
COPY services/dashboard-api/package.json services/dashboard-api/package.json

RUN npm install --no-audit --no-fund

COPY packages/lib/src/ packages/lib/src/
COPY services/dashboard-api/src/ services/dashboard-api/src/

EXPOSE 3003

WORKDIR /app/services/dashboard-api
CMD ["node", "src/index.js"]
