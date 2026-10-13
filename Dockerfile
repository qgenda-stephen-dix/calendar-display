FROM node:20-slim

WORKDIR /app

RUN apt-get update \
	&& apt-get install -y --no-install-recommends chromium \
	&& rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=8080
ENV CHROME_PATH=/usr/bin/chromium

EXPOSE 8080

CMD ["npm", "start"]