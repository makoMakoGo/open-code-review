# GitHub App bot（自托管 GitHub App 机器人）

[English](README.md) | 简体中文

自托管的 GitHub App 服务，封装 `ocr` CLI 并在 Pull Request 上发布代码审查评论。

流程：

1. 用户在 Pull Request 下评论配置好的命令，例如 `/ocr review`。
2. GitHub 发送 `issue_comment.created` webhook。
3. 机器人校验 `X-Hub-Signature-256`。
4. 机器人检查发送者与仓库所有者的白名单。
5. 机器人将 PR head 拉取到临时工作目录。
6. 机器人执行 `ocr review --from <base_sha> --to <head_sha> --format json`。
7. 机器人通过 GitHub 的 Pull Request review API 发布审查评论。
8. 任务结束后删除临时工作目录。

这个机器人刻意做得简单：单进程、内存队列、一次只跑一个审查任务。OCR 的文件级并发可配置，默认为 `1`，对并发能力较弱的 LLM 提供方更安全。

## 文件

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

以下运行期文件不纳入版本管理：

```text
deploy/.env
deploy/github-app-private-key.pem
deploy/data/
```

## 创建 GitHub App

在用户或组织账号下创建一个 GitHub App。

权限：

```text
Metadata: Read-only
Contents: Read-only
Issues: Read and write
Pull requests: Read and write
```

Webhook：

```text
Active: yes
Webhook URL: https://<your-domain>/github/webhook
Webhook secret: random long string
Events: Issue comment
```

将该 App 安装到需要使用的仓库或账号上。

## 配置

复制部署 env 示例：

```bash
cd github-app-bot/deploy
cp .env.example .env
mkdir -p data/repos data/admin
chmod 600 .env
sudo chown -R 10001:10001 data
```

将 GitHub App 私钥放到：

```text
github-app-bot/deploy/github-app-private-key.pem
```

建议的权限：

```bash
chmod 600 github-app-private-key.pem
```

`.env` 里的私钥路径是容器内路径：

```env
GITHUB_APP_PRIVATE_KEY_PATH=/config/github-app-private-key.pem
```

`.env` 中的必填项：

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

兼容 OpenAI Chat Completions 的端点：

```env
OCR_USE_ANTHROPIC=false
OCR_LLM_AUTH_HEADER=
OCR_LLM_URL=https://api.example.com/v1
OCR_LLM_MODEL=your-model
```

需要本地改写 header 的 Anthropic 兼容端点（走本地代理）：

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

本地代理接受 OCR 的 `Authorization: Bearer <LLM_PROXY_INTERNAL_TOKEN>` 或 `X-Api-Key: <LLM_PROXY_INTERNAL_TOKEN>`，随后用 `LLM_PROXY_UPSTREAM_AUTH_HEADER` 和 `LLM_PROXY_UPSTREAM_TOKEN` 替换为供应商鉴权。不要通过公网反向代理暴露 `/llm/*`。

## 管理面板

管理面板代码随发布镜像一起提供。将 `ADMIN_PASSWORD` 设置为至少 16 个字符后，内置管理面板会在 `/admin/` 启用。`ADMIN_PASSWORD` 未设置或过短时，`/admin/*` 会在 Host guard 之后返回 404。

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

`ADMIN_DATA_DIR` 是运行时状态目录，应允许 UID/GID `10001` 写入；`/config` 保持只读。在 VPS 上，`/data/admin` 对应 `github-app-bot/deploy/data/admin`。配置优先级为代码默认值、环境变量、`/data/admin/config-overrides.json`。面板可编辑除 `ADMIN_PASSWORD`、`ADMIN_DATA_DIR` 和旧别名 `ADMIN_STORAGE_DIR` 之外的机器人配置。排队任务在真正开始时读取最新配置；运行中的任务保留开始时的配置快照。`PORT` 变更会和待重启标记一起写入，并在进程成功绑定目标端口后清除。

面板在 `/data/admin` 下保存任务历史、受限大小的单任务日志、每日统计、配置审计、会话状态和保留策略状态。日志只保存阶段消息、错误、git stderr 和 OCR stderr；不保存 OCR stdout、webhook payload、原始供应商输出或密钥。保留策略在启动时运行一次，之后每 `RETENTION_INTERVAL_HOURS` 小时运行一次。默认保留任务详情 90 天、日志 14 天、统计和配置审计 365 天，单任务日志上限 5 MiB，并对 `/data/admin` 应用 512 MiB 软上限。

所有管理 POST 请求都必须包含同源 `Origin` 或 `Referer`，并通过 CSRF 校验。管理 cookie 使用 `HttpOnly`、`SameSite=Strict`、`Path=/admin/`；`ADMIN_COOKIE_SECURE=true` 时带 `Secure`。除非进程位于可信反向代理后方且代理会覆盖 `X-Real-IP` 和 `X-Forwarded-Proto`，否则保持 `ADMIN_TRUST_PROXY=false`。

## 运行

```bash
cd github-app-bot/deploy
docker compose pull
docker compose up -d
```

健康检查：

```bash
curl http://127.0.0.1:3007/health
```

预期响应：

```json
{"ok":true,"service":"open-code-review-github-app-bot"}
```

## 镜像构建与升级

机器人镜像由 GitHub Actions 根据 `github-app-bot/Dockerfile` 构建，并推送到 GHCR：`ghcr.io/makomakogo/open-code-review-github-app-bot:latest`。

Dockerfile 有意安装 `@alibaba-group/open-code-review@latest`。镜像 workflow 使用 `--pull --no-cache` 构建，因此每次构建都会解析 npm 当前 latest 版本，而不是复用旧 Docker layer。构建日志里的 `ocr --version` 就是进入镜像的实际 OCR 版本。

VPS 升级：

```bash
cd github-app-bot/deploy
docker compose pull
docker compose up -d
```

## 反向代理

仅在明确启用管理面板时暴露 `/admin/*`。不要公开暴露 `/llm/*`。

```text
GET  /health
POST /github/webhook
GET  /admin/
GET  /admin/*
POST /admin/*
```

OpenResty server 块示例：

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

## 运维说明

- 机器人只接受 trim 后与 `BOT_TRIGGER_PHRASES` 完全匹配的 PR 评论。
- 发送者鉴权同时校验 `sender.login` 和 `sender.id`。
- 仓库鉴权校验 `repository.owner.login`。
- 私有仓库一律忽略；本机器人仅通过公开 HTTPS remote 拉取 Pull Request。
- 重启后，已排队和运行中的任务会恢复为 `interrupted`；不会自动重试。
- `OCR_CONCURRENCY=1` 会串行化 OCR 的文件审查。仅当 LLM 提供方能承受并发时再调高。
- 失败评论会归类为 checkout、GitHub API、超时、配置错误、供应商鉴权失败、限流、供应商不可用、PR 过期、OCR 输出非法和运行时错误。评论包含诊断 id，但不会包含原始 OCR 输出或供应商响应。
- `CLEANUP_WORKDIR=true` 会在每次任务结束后删除 `/data/repos/<owner>-<repo>-<pr>-<sha>`。
