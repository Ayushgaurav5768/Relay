FROM node:20-alpine
WORKDIR /app

COPY package.json package-lock.json ./
COPY services/client/package.json services/client/package.json

RUN npm install --no-audit --no-fund

COPY services/client/ services/client/

EXPOSE 5173

WORKDIR /app/services/client
CMD ["npx", "vite", "--host", "0.0.0.0"]
