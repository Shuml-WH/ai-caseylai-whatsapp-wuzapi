# WhatsApp via WuzAPI + Cloudflare Worker

A self-hosted WhatsApp bot with a web UI. Register a virtual phone as a secondary device, send and receive messages from a browser.

**Runs on Cloudflare's FREE tier.**

## Architecture

```
Your PC                              Cloudflare Edge (FREE)
┌──────────────────────┐            ┌──────────────────────────────┐
│ wuzapi.exe  :8080    │            │ Worker (frontend + API)      │
│ (WhatsApp WebSocket) │◄──tunnel───│ D1 (database + auth)         │
│                      │            │ workers.dev (DNS)            │
│ relay.py    :3100    │            └──────────────────────────────┘
│ (webhook receiver)   │
└──────────────────────┘
```

The only component that runs locally is **wuzapi** — it holds the persistent WebSocket connection to WhatsApp. Everything else runs on Cloudflare's free tier.

## Cloudflare Services

| Service | How it's used | Deployed via |
|---|---|---|
| **Workers** | Serves the web UI (register + send message pages), proxies API calls to wuzapi, runs all backend logic | `wrangler deploy` |
| **D1 (Database)** | Stores bot metadata, message history, and API keys. SQLite-compatible, available at the edge even when your PC is off | `wrangler d1 execute` |
| **Authentication** | API keys validated against D1 at the Worker layer. Admin and send-only roles. Keys never touch wuzapi — the Worker validates your key, then uses an internal token for wuzapi calls | Built into the Worker |
| **DNS** | `workers.dev` serves the Worker. `trycloudflare.com` routes the tunnel to your PC. Both auto-provisioned — no domain needed | Automatic via wrangler + cloudflared |

**Storage (R2)** is available on Cloudflare's free tier (10 GB) but not yet enabled — requires a one-time activation in the Cloudflare Dashboard.

## Prerequisites

The repo doesn't include binaries — download them once:

| File | Where to get it |
|---|---|
| `wuzapi.exe` | [github.com/asternic/wuzapi/releases](https://github.com/asternic/wuzapi/releases) — download the latest Windows exe |
| `cloudflared.exe` | [github.com/cloudflare/cloudflared/releases](https://github.com/cloudflare/cloudflared/releases) — download `cloudflared-windows-amd64.exe` and rename to `cloudflared.exe` |

Or use package managers:
```bash
winget install cloudflare.cloudflared    # cloudflared
# wuzapi: manual download from GitHub releases
```

Place both `.exe` files in the project root, next to `launcher.py`.

You also need:
- **Python 3** (for `launcher.py` and `relay.py`)
- **Node.js** (for `wrangler deploy`)
- A **Cloudflare account** (free tier) — run `npx wrangler login`

## Quick Start

### 1. Start local services

```bash
python launcher.py
```

This starts wuzapi, relay, and cloudflared together. The launcher auto-deploys the Worker whenever the tunnel URL changes.

### 2. Open the app

Visit `https://<your-worker>.workers.dev` — the URL is printed when you run `npm run deploy`.

### 3. Register a bot

1. Enter a bot name
2. Admin password: `my-admin-secret-token`
3. Click **Generate QR Code**
4. Scan with WhatsApp: Settings → Linked Devices → Link a Device

### 4. Send a message

Go to `/site/send-message`, enter a phone number with country code, type your message, and click Send.

## How It Works

| Component | Runs on | Purpose |
|---|---|---|
| **Worker** | Cloudflare Edge | Serves HTML pages, proxies API calls, validates auth, queries D1 |
| **D1** | Cloudflare Edge | Persistent storage — bot list, message history, API keys |
| **wuzapi** | Your PC | WhatsApp WebSocket connection, QR generation, message sending |
| **cloudflared** | Your PC | Secure tunnel from Cloudflare Edge to your PC |
| **relay.py** | Your PC | Webhook relay for incoming messages |

## API Keys

API keys are managed through the Worker — not hardcoded in wuzapi. Create, list, and revoke keys via the API:

```bash
# Create a new key
curl -X POST https://<your-worker>.workers.dev/api/keys \
  -H "Content-Type: application/json" \
  -H "X-Admin-Password: my-admin-secret-token" \
  -d '{"name":"My Key","role":"admin"}'

# List all keys (masked)
curl https://<your-worker>.workers.dev/api/keys \
  -H "X-Admin-Password: my-admin-secret-token"
```

Keys have roles: `admin` (register bots, manage keys) or `send-only` (send messages only).

## Endpoints

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /api/register-whatsapp` | Admin key | Register bot + get QR |
| `POST /api/send-message` | Any key | Send a message |
| `GET /api/userbots` | None | List registered bots |
| `GET /api/message-history` | None | Query message history |
| `GET /api/keys` | Admin key | List API keys |
| `POST /api/keys` | Admin key | Create API key |
| `DELETE /api/keys/:id` | Admin key | Revoke API key |
| `POST /api/incoming-message` | HMAC | Webhook receiver from wuzapi |

Default admin token: `my-admin-secret-token`.
