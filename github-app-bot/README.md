# GitHub App bot

Self-hosted GitHub App service that wraps the `ocr` CLI and posts pull request review comments.

Flow:

1. A user comments the configured command on a pull request, for example `/ocr review`.
2. GitHub sends an `issue_comment.created` webhook.
3. The bot verifies `X-Hub-Signature-256`.
4. The bot checks sender and repository owner allowlists.
5. The bot fetches the PR head into a temporary worktree.
6. The bot runs `ocr review --from origin/<base> --to <head_sha> --format json`.
7. The bot posts OCR comments through GitHub's pull request review API.
8. The temporary worktree is deleted when the job finishes.

The bot is intentionally boring: one process, one in-memory queue, one review job at a time. OCR file-level concurrency is configurable and defaults to `1`, which is safer for low-concurrency LLM providers.

## Files

```text
github-app-bot/
  Dockerfile
  docker-compose.yml
  package.json
  src/server.js
  config/bot.env.example
  test/trigger.test.js
```

Runtime-only files are not committed:

```text
config/bot.env
config/github-app-private-key.pem
data/
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

Copy the example env file:

```bash
mkdir -p config data/repos
cp config/bot.env.example config/bot.env
chmod 755 config
chmod 600 config/bot.env
sudo chown -R 10001:10001 data
```

Put the GitHub App private key at:

```text
config/github-app-private-key.pem
```

Recommended permissions:

```bash
sudo chown 10001:10001 config/github-app-private-key.pem
chmod 600 config/github-app-private-key.pem
```

Required values in `config/bot.env`:

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
OCR_LLM_AUTH_HEADER=x-internal-token
LLM_PROXY_TARGET_URL=https://provider.example.com/anthropic/v1/messages
LLM_PROXY_USER_AGENT=open-code-review-github-app-bot/0.1.0
LLM_PROXY_X_APP=
LLM_PROXY_INTERNAL_TOKEN=local-proxy-token
LLM_PROXY_BODY_LIMIT_BYTES=67108864
LLM_PROXY_UPSTREAM_AUTH_HEADER=authorization
LLM_PROXY_UPSTREAM_TOKEN=Bearer provider-token
```

The local proxy requires `X-Internal-Token` and is intended only for OCR traffic from inside the same container. Do not expose `/llm/*` through the public reverse proxy.

## Run

```bash
docker compose build
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

## Reverse proxy

Only expose these paths publicly:

```text
GET  /health
POST /github/webhook
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
- The queue is in-memory. Restarting the container drops queued but not-yet-started jobs.
- `OCR_CONCURRENCY=1` serializes OCR file reviews. Raise only if the LLM provider can handle concurrent requests.
- `CLEANUP_WORKDIR=true` deletes `/data/repos/<owner>-<repo>-<pr>-<sha>` after each job.
