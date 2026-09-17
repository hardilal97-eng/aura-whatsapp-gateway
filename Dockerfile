FROM node:20-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./

RUN npm install --omit=dev \
    && npm cache clean --force

COPY . .

RUN mkdir -p /app/data \
    && chown -R 1000:1000 /app

USER 1000:1000

EXPOSE 8080

CMD ["npm", "start"]
