FROM node:20-bookworm-slim

ENV NODE_ENV=production \
    OCR_NO_UPDATE=1

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates openssh-client \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
  && npm install -g @alibaba-group/open-code-review@latest \
  && ocr --version \
  && npm cache clean --force

RUN useradd --create-home --uid 10001 appuser
COPY src ./src
RUN chown -R appuser:appuser /app

EXPOSE 3007
USER appuser
CMD ["node", "src/server.js"]
