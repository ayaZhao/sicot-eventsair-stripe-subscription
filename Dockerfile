FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY scripts ./scripts
COPY readme.md ./
COPY .env.example ./

RUN mkdir -p /app/logs /app/.runtime \
  && chown -R node:node /app

USER node

ENV PORT=3000
EXPOSE 3000

CMD ["npm", "run", "webhook"]
