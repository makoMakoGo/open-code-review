# syntax=docker/dockerfile:1

ARG GO_IMAGE=golang:1.25.5-bookworm
ARG NODE_IMAGE=node:20-bookworm-slim

# Stage 1: build the ocr binary from this checkout.
# Upgrading = git pull + docker compose build; no npm registry involved.
FROM ${GO_IMAGE} AS ocr-builder
WORKDIR /src

ARG GOPROXY=https://proxy.golang.org,direct
ENV GOPROXY=${GOPROXY} \
    GOTOOLCHAIN=local

COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal

ARG OCR_VERSION=source
ARG OCR_GIT_COMMIT=unknown
ARG OCR_BUILD_DATE=unknown
RUN CGO_ENABLED=0 go build -trimpath \
  -ldflags "-s -w -X main.Version=${OCR_VERSION} -X main.GitCommit=${OCR_GIT_COMMIT} -X main.BuildDate=${OCR_BUILD_DATE}" \
  -o /out/ocr ./cmd/opencodereview

# Stage 2: bot runtime.
FROM ${NODE_IMAGE}

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates openssh-client \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY github-app-bot/package.json github-app-bot/package-lock.json ./
RUN npm ci --omit=dev
COPY --from=ocr-builder /out/ocr /usr/local/bin/ocr
RUN useradd --create-home --uid 10001 appuser

COPY github-app-bot/src ./src
RUN chown -R appuser:appuser /app

ENV NODE_ENV=production
EXPOSE 3007
USER appuser
CMD ["node", "src/server.js"]
