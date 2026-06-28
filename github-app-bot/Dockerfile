FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates openssh-client \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
  && npm install -g @alibaba-group/open-code-review@1.6.5
RUN useradd --create-home --uid 10001 appuser


COPY src ./src
RUN chown -R appuser:appuser /app


ENV NODE_ENV=production
EXPOSE 3007
USER appuser
CMD ["node", "src/server.js"]
