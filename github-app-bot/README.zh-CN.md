# GitHub App bot（自托管 GitHub App 机器人）

[English](README.md) | 简体中文

自托管的 GitHub App 服务，封装 `ocr` CLI 并在 Pull Request 上发布代码审查评论。

流程：

1. 用户在 Pull Request 下评论配置好的命令，例如 `/ocr review`。
2. GitHub 发送 `issue_comment.created` webhook。
3. 机器人校验 `X-Hub-Signature-256`。
4. 机器人检查发送者与仓库所有者的白名单。
5. 机器人将 PR head 拉取到临时工作目录。
6. 机器人执行 `ocr review --from origin/<base> --to <head_sha> --format json`。
7. 机器人通过 GitHub 的 Pull Request review API 发布审查评论。
8. 任务结束后删除临时工作目录。

这个机器人刻意做得简单：单进程、内存队列、一次只跑一个审查任务。OCR 的文件级并发可配置，默认为 `1`，对并发能力较弱的 LLM 提供方更安全。

## 文件

```text
github-app-bot/
  Dockerfile
  docker-compose.yml
  package.json
  package-lock.json
  src/server.js
  config/bot.env.example
  test/trigger.test.js
  README.md
  README.zh-CN.md
```

以下运行期文件不纳入版本管理：

```text
config/bot.env
config/github-app-private-key.pem
data/
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

复制示例 env 文件：

```bash
mkdir -p config data/repos
cp config/bot.env.example config/bot.env
chmod 755 config
chmod 600 config/bot.env
sudo chown -R 10001:10001 data
```

将 GitHub App 私钥放到：

```text
config/github-app-private-key.pem
```

建议的权限：

```bash
sudo chown 10001:10001 config/github-app-private-key.pem
chmod 600 config/github-app-private-key.pem
```

`config/bot.env` 中的必填项：

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

## 运行

```bash
docker compose build
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

## 反向代理

只对外暴露以下路径：

```text
GET  /health
POST /github/webhook
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
- 队列位于内存中。重启容器会丢弃已入队但尚未开始的任务。
- `OCR_CONCURRENCY=1` 会串行化 OCR 的文件审查。仅当 LLM 提供方能承受并发时再调高。
- 失败评论会归类为 checkout、GitHub API、超时、配置错误、供应商鉴权失败、限流、供应商不可用、PR 过期、OCR 输出非法和运行时错误。评论包含诊断 id，但不会包含原始 OCR 输出或供应商响应。
- `CLEANUP_WORKDIR=true` 会在每次任务结束后删除 `/data/repos/<owner>-<repo>-<pr>-<sha>`。
