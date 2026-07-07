# GitHub App bot

English | [简体中文](README.zh-CN.md)

Self-hosted GitHub App service that wraps the `ocr` CLI and posts pull request review comments.

Flow:

1. A user comments the configured command on a pull request, for example `/ocr review`.
2. GitHub sends an `issue_comment.created` webhook.
3. The bot verifies `X-Hub-Signature-256`.
4. The bot checks sender and repository owner allowlists.
5. The bot fetches the PR head into a temporary worktree.
6. The bot runs `ocr review --from <base_sha> --to <head_sha> --format json`.
7. The bot posts OCR comments through GitHub's pull request review API.
8. The temporary worktree is deleted when the job finishes.

The bot is intentionally boring: one process, one in-memory queue, one review job at a time. OCR file-level concurrency is configurable and defaults to `1`, which is safer for low-concurrency LLM providers.

## Files

```text
github-app-bot/
  Dockerfile
  package.json
  package-lock.json
  src/server.js
  deploy/docker-compose.yml
  deploy/.env.example
  test/trigger.test.js
  README.md
  README.zh-CN.md
```

Runtime-only files are not committed:

```text
deploy/.env
deploy/github-app-private-key.pem
deploy/data/
```

## GitHub App setup

Create a GitHub App under a user or organization account.

Permissions:

```text
Metadata: Read-only
Contents: Read-only
Issues: Read and write
Pull requests: Read and write
```

Webhook:

```text
Active: yes
Webhook URL: https://<your-domain>/github/webhook
Webhook secret: random long string
Events: Issue comment
```

Install the App on the repositories or accounts that should use it.

## Configuration

Copy the deploy env example:

```bash
cd github-app-bot/deploy
cp .env.example .env
mkdir -p data/repos data/admin
chmod 600 .env
sudo chown -R 10001:10001 data
```

Put the GitHub App private key at:

```text
github-app-bot/deploy/github-app-private-key.pem
```

Recommended permissions:

```bash
chmod 600 github-app-private-key.pem
```

The private key path in `.env` is the container path:

```env
GITHUB_APP_PRIVATE_KEY_PATH=/config/github-app-private-key.pem
```

Required values in `.env`:

```env
BOT_TRIGGER_PHRASE=/ocr review
BOT_TRIGGER_PHRASES=/ocr review
ALLOWED_USERS=your-login,friend-login
ALLOWED_USER_IDS=
ALLOWED_REPO_OWNERS=your-login,friend-login

GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY_PATH=/config/github-app-private-key.pem
GITHUB_WEBHOOK_SECRET=replace-with-random-hex

OCR_LLM_URL=https://api.anthropic.com
OCR_LLM_TOKEN=replace-with-llm-token
OCR_LLM_MODEL=claude-sonnet-4-6
OCR_USE_ANTHROPIC=true
OCR_LLM_AUTH_HEADER=x-api-key
WEBHOOK_BODY_LIMIT_BYTES=1048576
LLM_PROXY_BODY_LIMIT_BYTES=67108864
```

For OpenAI-compatible Chat Completions endpoints:

```env
OCR_USE_ANTHROPIC=false
OCR_LLM_AUTH_HEADER=
OCR_LLM_URL=https://api.example.com/v1
OCR_LLM_MODEL=your-model
```

For Anthropic-compatible endpoints that require a local header-rewriting proxy:

```env
OCR_LLM_URL=http://127.0.0.1:3007/llm/anthropic
OCR_LLM_TOKEN=local-proxy-token
OCR_LLM_MODEL=claude-sonnet-4-6
OCR_USE_ANTHROPIC=true
OCR_LLM_AUTH_HEADER=authorization
LLM_PROXY_TARGET_URL=https://provider.example.com/anthropic/v1/messages
LLM_PROXY_USER_AGENT=open-code-review-github-app-bot/0.1.0
LLM_PROXY_X_APP=
LLM_PROXY_INTERNAL_TOKEN=local-proxy-token
LLM_PROXY_BODY_LIMIT_BYTES=67108864
LLM_PROXY_UPSTREAM_AUTH_HEADER=authorization
LLM_PROXY_UPSTREAM_TOKEN=Bearer provider-token
```

The local proxy accepts OCR's `Authorization: Bearer <LLM_PROXY_INTERNAL_TOKEN>` or `X-Api-Key: <LLM_PROXY_INTERNAL_TOKEN>`, then replaces it with `LLM_PROXY_UPSTREAM_AUTH_HEADER` and `LLM_PROXY_UPSTREAM_TOKEN` for the provider. Do not expose `/llm/*` through the public reverse proxy.

## Admin dashboard

The admin dashboard code is included in the published image. Set `ADMIN_PASSWORD` to a value with at least 16 characters to enable the embedded dashboard at `/admin/`. If `ADMIN_PASSWORD` is unset or too short, `/admin/*` returns 404 after the Host guard.

```env
ADMIN_PASSWORD=replace-with-long-admin-password
ADMIN_DATA_DIR=/data/admin
ADMIN_ALLOWED_HOSTS=review.example.com
ADMIN_SESSION_TTL_HOURS=12
ADMIN_COOKIE_SECURE=true
ADMIN_TRUST_PROXY=true
JOB_HISTORY_RETENTION_DAYS=90
JOB_LOG_RETENTION_DAYS=14
STATS_RETENTION_DAYS=365
CONFIG_AUDIT_RETENTION_DAYS=365
JOB_LOG_MAX_BYTES=5242880
ADMIN_DATA_MAX_BYTES=536870912
RETENTION_INTERVAL_HOURS=6
```

`ADMIN_DATA_DIR` is runtime state and should be writable by UID/GID `10001`; `/config` stays read-only. On the VPS, `/data/admin` maps to `github-app-bot/deploy/data/admin`. Config precedence is code defaults, environment, then `/data/admin/config-overrides.json`. The dashboard can edit bot config except `ADMIN_PASSWORD`, `ADMIN_DATA_DIR`, and the legacy `ADMIN_STORAGE_DIR` alias. Queued jobs load the latest config when they start; running jobs keep their start-time config snapshot. `PORT` changes are written with a pending-restart marker, then cleared after the process successfully binds the requested port.

The dashboard stores job history, bounded per-job logs, daily stats, config audit records, session state, and retention state under `/data/admin`. Logs keep stage messages, errors, git stderr, and OCR stderr; they do not store OCR stdout, webhook payloads, raw provider output, or secrets. Retention runs at startup and then every `RETENTION_INTERVAL_HOURS` hours. Defaults retain task details for 90 days, logs for 14 days, stats and config audit records for 365 days, cap each job log at 5 MiB, and apply a 512 MiB soft cap to `/data/admin`.

All admin POSTs require same-origin `Origin` or `Referer` plus CSRF. Admin cookies are `HttpOnly`, `SameSite=Strict`, `Path=/admin/`, and use `Secure` when `ADMIN_COOKIE_SECURE=true`. Keep `ADMIN_TRUST_PROXY=false` unless the process is behind a trusted reverse proxy that overwrites `X-Real-IP` and `X-Forwarded-Proto`.

## Run

```bash
cd github-app-bot/deploy
docker compose pull
docker compose up -d
```

Health check:

```bash
curl http://127.0.0.1:3007/health
```

Expected response:

```json
{"ok":true,"service":"open-code-review-github-app-bot"}
```

## Image build and upgrades

The bot image is built by GitHub Actions from `github-app-bot/Dockerfile` and pushed to GHCR as `ghcr.io/makomakogo/open-code-review-github-app-bot:latest`.

The Dockerfile intentionally installs `@alibaba-group/open-code-review@latest`. The image workflow builds with `--pull --no-cache`, so each image build resolves the current npm latest version instead of reusing an old Docker layer. The build log prints `ocr --version`; that is the exact OCR version baked into the image.

To upgrade the VPS:

```bash
cd github-app-bot/deploy
docker compose pull
docker compose up -d
```

## Reverse proxy

Expose `/admin/*` only when the dashboard is intentionally enabled. Never expose `/llm/*` publicly.

```text
GET  /health
POST /github/webhook
GET  /admin/
GET  /admin/*
POST /admin/*
```

Example OpenResty server block:

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name review.example.com;

    location = /health {
        proxy_pass http://127.0.0.1:3007/health;
        access_log off;
    }

    location = /github/webhook {
        proxy_pass http://127.0.0.1:3007/github/webhook;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_http_version 1.1;
        proxy_connect_timeout 10s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }

    location = /admin {
        return 308 /admin/;
    }

    location /admin/ {
        proxy_pass http://127.0.0.1:3007/admin/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_http_version 1.1;
        proxy_connect_timeout 10s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }

    location / {
        return 404;
    }
}
```

## Operational notes

- The bot accepts only PR comments matching `BOT_TRIGGER_PHRASES` exactly after trimming whitespace.
- Sender authorization checks both `sender.login` and `sender.id`.
- Repository authorization checks `repository.owner.login`.
- Private repositories are always ignored; this bot fetches pull requests through public HTTPS remotes only.
- Queued and running jobs are recovered as `interrupted` after restart; no automatic retry is attempted.
- `OCR_CONCURRENCY=1` serializes OCR file reviews. Raise only if the LLM provider can handle concurrent requests.
- Failure comments are classified into checkout, GitHub API, timeout, configuration, provider authentication, rate-limit, provider availability, stale PR, invalid OCR output, and runtime failures. They include a diagnostic id but never include raw OCR output or provider responses.
- `CLEANUP_WORKDIR=true` deletes `/data/repos/<owner>-<repo>-<pr>-<sha>` after each job.
