FROM node:20-alpine AS base
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install

COPY src/ src/
