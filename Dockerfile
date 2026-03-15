FROM node:20-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci

# Digest fallback content fetching uses Playwright Chromium.
RUN npx playwright install --with-deps chromium

COPY . .

EXPOSE 4321

CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "4321"]
