# User Guide — WhatsApp Web App

The web app is at your Worker URL — printed when you run `npm run deploy` (looks like `https://<name>.<your-subdomain>.workers.dev`).

## Register a Bot

1. Open the app — you'll see the **Register UserBot** page
2. Enter a **bot name** (e.g. `my-bot`) — keep it simple, a-z and 0-9 only
3. Enter the **Admin Password**: `my-admin-secret-token`
4. Click **Generate QR Code**
5. A QR code appears — scan it with WhatsApp:
   - Open WhatsApp on your phone
   - **Settings** → **Linked Devices** → **Link a Device**
   - Point your phone at the QR code
6. Wait a few seconds — the page auto-detects the scan and shows **● Connected**

## Register a Second Bot

Same steps, just use a **different bot name** (e.g. `my-bot-2`). Same admin password.

Each bot links as a separate WhatsApp session — you can have multiple bots active at once.

## Send a Message

1. Click **Go to Send Message** (or visit `/site/send-message`)
2. The API Key is pre-filled — leave it as `my-admin-secret-token`
3. Select a **UserBot** from the dropdown (only connected bots appear)
4. Enter the destination **Phone Number** with country code (e.g. `85212345678`)
5. Type your **Message**
6. Click **Send Message**

## Delete a Bot

1. On the Register page, find the bot in the **Registered UserBots** list
2. Click **Delete** — confirm the prompt
3. The bot is removed from both WhatsApp and the app

## Troubleshooting

| Problem | Fix |
|---|---|
| "Cannot reach wuzapi" when registering | The launcher (`python launcher.py`) isn't running on your PC — start it |
| QR code doesn't appear | Wait a moment, the launcher may be restarting. If it persists, restart the launcher |
| QR scan says "Couldn't link device" | Unlink old devices from WhatsApp first. Try scanning again — iOS sometimes needs 2 attempts |
| Bot appears but no phone number (○ QR not scanned) | The QR was generated but never scanned. Delete and re-register |
| Send fails with "device JID" error | The bot you selected hasn't scanned its QR yet — only use bots with ● Connected status |
| Old bots reappear after delete | Click **Refresh List** to sync — the list is cached from D1 |
