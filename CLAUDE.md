# CLAUDE.md — AI Caseylai WhatsApp Wuzapi

This file provides guidance to Claude Code when working in this repository.

## What this project is

A self-hosted WhatsApp bot with a web UI — register a virtual phone as a secondary device, send and receive messages from a browser. Runs on Cloudflare's **FREE tier**.

Full details in [README.md](README.md).

## Architecture

```
Your PC                              Cloudflare Edge (FREE)
┌──────────────────────┐            ┌──────────────────────────────┐
│ wuzapi.exe  :8080    │            │ Worker (frontend + API)       │
│ (WhatsApp WebSocket) │◄──tunnel───│ D1 (database + auth)          │
│                      │            │ workers.dev (DNS)             │
│ relay.py    :3100    │            └──────────────────────────────┘
│ (webhook receiver)   │
└──────────────────────┘
```

- **wuzapi.exe** — WhatsApp REST API using the whatsmeow Go library. Holds the persistent WebSocket to WhatsApp.
- **relay.py** — Python webhook relay. Receives webhook POSTs from wuzapi, stores messages in memory, exposes GET endpoints for the frontend to poll (port 3100).
- **cloudflared.exe** — Cloudflare Tunnel client. Creates a secure tunnel from Cloudflare Edge to localhost:8080 (wuzapi).
- **Cloudflare Worker** (`worker.js`) — Serves HTML pages (register + send message), proxies API calls to wuzapi via the tunnel, validates API keys against D1, stores bot metadata and message history in D1.
- **D1 (Cloudflare)** — SQLite-compatible edge database. Stores userbots, messages, and API keys. Always available even when the PC/tunnel is down.

## Deployed App

The web app is deployed at:
- **Main**: https://ai-caseylai-whatsapp-wuzapi.tryprograming.workers.dev
- **Send Message page**: https://ai-caseylai-whatsapp-wuzapi.tryprograming.workers.dev/site/send-message
- **Register page**: https://ai-caseylai-whatsapp-wuzapi.tryprograming.workers.dev/site/register-whatsapp

## Quick Start

```bash
python launcher.py
```

This starts wuzapi, relay, and cloudflared together. The launcher auto-deploys the Worker whenever the tunnel URL changes.

## File Overview

| File | Purpose |
|---|---|
| `worker.js` | Cloudflare Worker — all backend logic, API handlers, HTML serving |
| `launcher.py` | Single-window launcher — starts wuzapi + relay + cloudflared, auto-deploys Worker |
| `relay.py` | Webhook relay — receives messages from wuzapi, serves them to frontend |
| `wrangler.toml` | Wrangler config — Worker name, D1 binding, compatibility date |
| `package.json` | npm scripts (`npm run dev` / `npm run deploy`) |
| `register.html` | HTML page for bot registration (imported by worker.js) |
| `send-message.html` | HTML page for sending messages (imported by worker.js) |
| `wuzapi.exe` | Prebuilt wuzapi binary (Windows) |
| `cloudflared.exe` | Prebuilt cloudflared binary (Windows) |
| `wuzapi.env` | Config for wuzapi (port, tokens, encryption keys, webhook URL) |
| `wuzapi.env.example` | Template for wuzapi.env |

## Key Commands

```bash
# Start everything
python launcher.py

# Deploy Worker manually
npm run deploy          # or: npx wrangler deploy

# Run Worker locally
npm run dev             # or: npx wrangler dev

# Execute D1 queries
npx wrangler d1 execute wuzapi-db --command "SELECT * FROM userbots"
npx wrangler d1 execute wuzapi-db --command "SELECT * FROM api_keys"
npx wrangler d1 execute wuzapi-db --command "SELECT * FROM messages ORDER BY created_at DESC LIMIT 20"

# Put a secret
npx wrangler secret put WUZAPI_URL
npx wrangler secret put WUZAPI_ADMIN_TOKEN
npx wrangler secret put WUZAPI_HMAC_KEY
```

## API Endpoints

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

## Credentials & Defaults

- Admin token: `my-admin-secret-token`
- Wuzapi port: `8080`, Relay port: `3100`
- Worker name: `ai-caseylai-whatsapp-wuzapi`
- D1 database: `wuzapi-db` (bound as `wuzapi_db`)
- WhatsApp phone: `+852 5520 3890`

## Common Issues

- **Tunnel URL changed / Worker can't reach wuzapi**: The cloudflared tunnel URL is ephemeral. Kill cloudflared, restart — the launcher auto-deploys the Worker with the new `WUZAPI_URL` secret. If not, run manually: `npx wrangler secret put WUZAPI_URL && npm run deploy`.
- **wuzapi hangs / SQLite locks**: Force-killing wuzapi leaves WAL files locked. Delete `dbdata/*.db-wal` and `dbdata/*.db-shm`, restart.
- **Port 8080 already in use**: Kill all wuzapi processes (`taskkill /F /IM wuzapi.exe`) and restart.
- **"user with this token already exists"**: Only one bot can exist with token `my-admin-secret-token`. Delete the existing user first via the API or D1.
- **QR scan fails ("Couldn't link device")**: wuzapi binary may use an outdated whatsmeow library. Unlink all devices from WhatsApp first, retry (iOS needs 2 attempts), or rebuild wuzapi from source with latest whatsmeow.
