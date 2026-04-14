FROM node:22-slim

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

ENV PORT=3000
ENV REQUIRE_AUTH=true

EXPOSE 3000

CMD ["node", "dist/index.js"]
