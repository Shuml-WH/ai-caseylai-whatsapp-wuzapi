/**
 * WhatsApp Worker — serves HTML + D1 database + proxies to wuzapi.
 *
 * Architecture:
 *   Browser → Worker → cloudflared tunnel → wuzapi (your PC)
 *              └─→ D1 (bot list, messages, API keys)
 *
 * D1 is Cloudflare's edge SQLite — always available, even when tunnel is down.
 */

// @ts-ignore
import registerHtml from "./register.html";
// @ts-ignore
import sendMessageHtml from "./send-message.html";

export default {
  async fetch(request, env, _ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const method = request.method;

    const WUZAPI = env.WUZAPI_URL || "http://localhost:8080";
    const DB = env.wuzapi_db;

    if (method === "OPTIONS") {
      return corsResponse();
    }

    try {
      // ── Static Pages ──
      if ((pathname === "/" || pathname === "/site/register-whatsapp") && method === "GET") {
        return htmlResponse(registerHtml);
      }
      if (pathname.startsWith("/site/send-message") && method === "GET") {
        return htmlResponse(sendMessageHtml);
      }

      // ── Health ──
      if (pathname === "/api/health" && method === "GET") {
        return corsResponse(Response.json({ status: "ok", arch: "wuzapi-proxy-d1" }));
      }

      // ── API: Register ──
      if (pathname === "/api/register-whatsapp" && method === "POST") {
        return await handleRegister(request, env, WUZAPI, DB);
      }

      // ── API: Send Message ──
      if (pathname === "/api/send-message" && method === "POST") {
        return await handleSendMessage(request, WUZAPI, DB);
      }

      // ── API: Status ──
      const statusMatch = pathname.match(/^\/api\/status\/([a-zA-Z0-9_-]+)$/);
      if (statusMatch && method === "GET") {
        return await handleStatus(request, WUZAPI, DB, statusMatch[1]);
      }

      // ── API: Poll Messages ──
      const msgMatch = pathname.match(/^\/api\/messages\/([a-zA-Z0-9_-]+)$/);
      if (msgMatch && method === "GET") {
        return await handlePollMessages(request, WUZAPI, DB, msgMatch[1]);
      }

      // ── API: List UserBots ──
      if (pathname === "/api/userbots" && method === "GET") {
        return await handleListUserBots(DB);
      }

      // ── API: Message History (D1) ──
      if (pathname === "/api/message-history" && method === "GET") {
        return await handleMessageHistory(request, DB);
      }

      // ── API: Delete UserBot ──
      const delMatch = pathname.match(/^\/api\/userbots\/([a-zA-Z0-9_-]+)$/);
      if (delMatch && method === "DELETE") {
        return await handleDeleteUserBot(request, WUZAPI, DB, delMatch[1]);
      }

      // ── API: Sync bot from wuzapi to D1 ──
      if (pathname === "/api/sync-bots" && method === "POST") {
        return await handleSyncBots(WUZAPI, DB);
      }

      // ── Webhook: Incoming Message from wuzapi ──
      if (pathname === "/api/incoming-message" && method === "POST") {
        return await handleIncomingWebhook(request, env, DB);
      }

      // ── API: Key Management ──
      if (pathname === "/api/keys" && method === "GET") {
        return await handleListKeys(request, DB);
      }
      if (pathname === "/api/keys" && method === "POST") {
        return await handleCreateKey(request, DB);
      }
      const delKeyMatch = pathname.match(/^\/api\/keys\/(.+)$/);
      if (delKeyMatch && method === "DELETE") {
        return await handleDeleteKey(request, DB, delKeyMatch[1]);
      }

      // ── 404 ──
      return corsResponse(Response.json(
        { error: "NOT_FOUND", message: "Not found" },
        { status: 404 }
      ));
    } catch (err) {
      console.error("[worker]", err);
      return corsResponse(Response.json(
        { error: "INTERNAL_ERROR", message: err.message },
        { status: 500 }
      ));
    }
  },
};

// ── API HANDLERS ──

/**
 * POST /api/register-whatsapp
 * Creates user in wuzapi, connects, returns QR code.
 * Saves bot metadata to D1 for persistent tracking.
 */
async function handleRegister(request, env, wuzapi, db) {
  const body = await request.json().catch(() => ({}));
  const userBot = (body.userBot || "").trim();
  const apiKey = request.headers.get("X-Admin-Password") || "";
  const wuzapiToken = env.WUZAPI_ADMIN_TOKEN || "my-admin-secret-token";

  if (!userBot || !apiKey) {
    return corsResponse(Response.json(
      { error: "BAD_REQUEST", message: "Missing userBot or admin password" },
      { status: 400 }
    ));
  }

  // Validate API key against D1
  const keyValid = await validateApiKey(db, apiKey);
  if (!keyValid) {
    return corsResponse(Response.json(
      { error: "UNAUTHORIZED", message: "Invalid admin password / API key" },
      { status: 401 }
    ));
  }

  // Generate a unique token per bot (wuzapi requires unique tokens)
  const botToken = userBot + "-" + crypto.randomUUID().slice(0, 8);
  const adminToken = env.WUZAPI_ADMIN_TOKEN || "my-admin-secret-token";

  // Step 1: Create user in wuzapi
  let createRes, createData;
  try {
    createRes = await fetch(wuzapi + "/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": adminToken },
      body: JSON.stringify({ name: userBot, token: botToken }),
      signal: AbortSignal.timeout(10000),
    });
    createData = await createRes.json().catch(() => ({}));
  } catch (e) {
    return corsResponse(Response.json(
      { error: "REGISTRATION_FAILED", message: "Cannot reach wuzapi. Is the launcher running?" },
      { status: 500 }
    ));
  }

  // 409 "token exists" — retry with a different token
  if (createRes.status === 409) {
    return corsResponse(Response.json(
      { error: "ALREADY_EXISTS", message: "A bot with this name may already exist. Try a different name." },
      { status: 409 }
    ));
  }

  if (!createRes.ok && createRes.status !== 500) {
    return corsResponse(Response.json(
      { error: "REGISTRATION_FAILED", message: createData.error || createData.message || "Failed to create bot" },
      { status: 500 }
    ));
  }

  // Save bot metadata to D1 — store botToken for future use
  const botId = createData?.data?.id || createData?.id || "";
  if (botId) {
    try {
      await db.prepare(
        "INSERT OR REPLACE INTO userbots (id, name, token, connected, logged_in, created_at, updated_at) VALUES (?1, ?2, ?3, 0, 0, datetime('now'), datetime('now'))"
      ).bind(botId, userBot, botToken).run();
    } catch (e) {
      console.error("[d1] Failed to save bot:", e.message);
    }
  }

  // Step 2: Connect — use botToken
  try {
    await fetch(wuzapi + "/session/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json", "token": botToken },
      body: JSON.stringify({ Immediate: true }),
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    // Connect may time out but QR might still be generated
  }

  // Step 3: Read QR from users list using botToken (avoids /session/qr which can hang)
  for (let attempt = 0; attempt < 6; attempt++) {
    await new Promise(r => setTimeout(r, 2000));
    try {
      const usersRes = await fetch(wuzapi + "/admin/users", {
        headers: { "Authorization": adminToken },
        signal: AbortSignal.timeout(5000),
      });
      const usersData = await usersRes.json().catch(() => ({}));
      const users = usersData.data || [];
      const bot = users.find(u => u.name === userBot || u.id === botId);
      const qrCode = bot?.qrcode || "";

      if (qrCode) {
        // Update D1 with connected status
        if (botId) {
          try {
            await db.prepare(
              "UPDATE userbots SET connected = 1, updated_at = datetime('now') WHERE id = ?1"
            ).bind(botId).run().catch(() => {});
          } catch {}
        }

        return corsResponse(Response.json({
          link: qrCode,
          userBot,
          status: "pending_scan",
        }));
      }

      // Check if already logged in (has JID)
      if (bot?.jid) {
        return corsResponse(Response.json({
          link: "",
          userBot,
          status: "already_connected",
        }));
      }
    } catch {
      // Still connecting
    }
  }

  return corsResponse(Response.json(
    { error: "REGISTRATION_FAILED", message: "Connection still initializing. Please wait and refresh — your bot may already be connected." },
    { status: 202 }
  ));
}

/**
 * POST /api/send-message
 * Sends via wuzapi and stores in D1 history.
 */
async function handleSendMessage(request, wuzapi, db) {
  const body = await request.json().catch(() => ({}));
  const phone = (body.phone || "").replace(/[^0-9]/g, "");
  const message = (body.message || "").replace(/\r?\n|\r/g, "\n");
  const userBot = body.userBot || "";
  const token = request.headers.get("X-API-Key") || "";

  if (!phone || !message || !token) {
    return corsResponse(Response.json(
      { error: "BAD_REQUEST", message: "Missing phone, message, or API key" },
      { status: 400 }
    ));
  }

  // Validate API key against D1
  const keyValid = await validateApiKey(db, token);
  if (!keyValid) {
    return corsResponse(Response.json(
      { error: "UNAUTHORIZED", message: "Invalid API key" },
      { status: 401 }
    ));
  }

  // Look up the wuzapi token for this bot (different from API key)
  let wuzapiToken = token; // fallback
  if (userBot) {
    try {
      const bot = await db.prepare(
        "SELECT token FROM userbots WHERE name = ?1"
      ).bind(userBot).first();
      if (bot && bot.token) {
        wuzapiToken = bot.token;
      }
    } catch {}
  }

  const res = await fetch(wuzapi + "/chat/send/text", {
    method: "POST",
    headers: { "Content-Type": "application/json", "token": wuzapiToken },
    body: JSON.stringify({ phone, body: message }),
  });
  const data = await res.json().catch(() => ({}));

  const success = res.ok && (data.success || data.status === "success");

  // Store in D1 history
  try {
    await db.prepare(
      "INSERT INTO messages (userbot_name, phone, text, direction, status) VALUES (?1, ?2, ?3, 'out', ?4)"
    ).bind(userBot, phone, message, success ? "sent" : "failed").run();
  } catch {}

  if (success) {
    return corsResponse(Response.json({
      status: "sent",
      userBot,
      phone,
    }));
  }

  return corsResponse(Response.json({
    status: "failed",
    userBot,
    phone,
    error: data.error || data.message || "Send failed",
  }, { status: 500 }));
}

/**
 * GET /api/status/:userBot
 */
async function handleStatus(request, wuzapi, db, userBot) {
  const token = request.headers.get("X-Admin-Password") ||
                request.headers.get("X-API-Key") ||
                "";

  // Try wuzapi first, fall back to D1
  try {
    const res = await fetch(wuzapi + "/session/status", {
      headers: { "token": token },
      signal: AbortSignal.timeout(5000),
    });
    const data = await res.json().catch(() => ({}));
    return corsResponse(Response.json({
      connected: data.connected || data.isConnected || !!data.jid,
      user: data.jid || data.Jid || null,
      lastActivity: null,
      reconnectAttempts: 0,
      pendingMessages: 0,
      webhook: { url: "", enabled: false },
    }));
  } catch {
    // Fall back to D1
    try {
      const bot = await db.prepare(
        "SELECT * FROM userbots WHERE name = ?1"
      ).bind(userBot).first();
      if (bot) {
        return corsResponse(Response.json({
          connected: !!bot.connected,
          user: bot.phone || null,
          lastActivity: bot.updated_at,
          reconnectAttempts: 0,
          pendingMessages: 0,
          webhook: { url: "", enabled: false },
        }));
      }
    } catch {}
    return corsResponse(Response.json({
      connected: false, user: null, lastActivity: null,
      reconnectAttempts: 0, pendingMessages: 0, webhook: { url: "", enabled: false },
    }));
  }
}

/**
 * GET /api/messages/:userBot — reads from D1 (persistent message history)
 */
async function handlePollMessages(request, wuzapi, db, userBot) {
  // Read recent messages from D1 for this bot
  try {
    const { results } = await db.prepare(
      "SELECT * FROM messages WHERE userbot_name = ?1 ORDER BY created_at DESC LIMIT 100"
    ).bind(userBot).all();

    return corsResponse(Response.json({
      userBot,
      count: results.length,
      messages: results.reverse(), // oldest first
      source: "d1",
    }));
  } catch {
    return corsResponse(Response.json({ userBot, count: 0, messages: [], source: "d1-error" }));
  }
}

/**
 * GET /api/message-history — D1 message history
 * Query params: ?userbot=name&phone=123&limit=50
 */
async function handleMessageHistory(request, db) {
  const url = new URL(request.url);
  const userbot = url.searchParams.get("userbot") || "";
  const phone = url.searchParams.get("phone") || "";
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "50"), 200);

  let query = "SELECT * FROM messages WHERE 1=1";
  const params = [];

  if (userbot) {
    query += " AND userbot_name = ?" + (params.length + 1);
    params.push(userbot);
  }
  if (phone) {
    query += " AND phone = ?" + (params.length + 1);
    params.push(phone);
  }

  query += " ORDER BY created_at DESC LIMIT ?" + (params.length + 1);
  params.push(limit);

  try {
    const { results } = await db.prepare(query).bind(...params).all();
    return corsResponse(Response.json({ count: results.length, messages: results }));
  } catch (e) {
    return corsResponse(Response.json(
      { error: "DB_ERROR", message: e.message },
      { status: 500 }
    ));
  }
}

/**
 * GET /api/userbots — reads from D1 (always available)
 */
async function handleListUserBots(db) {
  try {
    const { results } = await db.prepare(
      "SELECT id, name, phone, connected, logged_in, updated_at FROM userbots ORDER BY updated_at DESC"
    ).all();

    const userBots = results.map(u => ({
      name: u.name,
      phone: u.phone || "unknown",
      connected: !!u.connected,
      loggedIn: !!u.logged_in,
      updatedAt: u.updated_at || "unknown",
    }));

    return corsResponse(Response.json({ userBots, source: "d1" }));
  } catch (e) {
    return corsResponse(Response.json(
      { error: "DB_ERROR", message: e.message, userBots: [] },
      { status: 500 }
    ));
  }
}

/**
 * DELETE /api/userbots/:userBot
 */
async function handleDeleteUserBot(request, wuzapi, db, userBot) {
  const token = request.headers.get("X-Admin-Password") || "";

  // Validate admin password against D1
  if (!token) {
    return corsResponse(Response.json(
      { error: "UNAUTHORIZED", message: "Admin password required" },
      { status: 401 }
    ));
  }
  const keyValid = await validateApiKey(db, token);
  if (!keyValid) {
    return corsResponse(Response.json(
      { error: "UNAUTHORIZED", message: "Invalid admin password / API key" },
      { status: 401 }
    ));
  }

  // Look up the bot's token and ID from D1
  let botToken = token;
  let botId = userBot;  // might be the name or the ID
  try {
    const bot = await db.prepare(
      "SELECT id, token FROM userbots WHERE name = ?1 OR id = ?1"
    ).bind(userBot).first();
    if (bot) {
      if (bot.token) botToken = bot.token;
      if (bot.id) botId = bot.id;
    }
  } catch {}

  // Delete from wuzapi using the bot's own token
  await fetch(wuzapi + "/session/logout", {
    method: "POST",
    headers: { "Content-Type": "application/json", "token": botToken },
    body: JSON.stringify({}),
  }).catch(() => {});

  // wuzapi delete needs the user ID (32-char hex), not the name
  await fetch(wuzapi + "/admin/users/" + encodeURIComponent(botId) + "/full", {
    method: "DELETE",
    headers: { "Authorization": token },
  }).catch(() => {});

  // Delete from D1
  try {
    await db.prepare("DELETE FROM userbots WHERE name = ?1 OR id = ?1").bind(userBot).run();
  } catch {}

  return corsResponse(Response.json({ status: "deleted", userBot }));
}

/**
 * POST /api/sync-bots — sync wuzapi state to D1
 * Call this to update D1 with current wuzapi bot state.
 */
async function handleSyncBots(wuzapi, db) {
  const token = "my-admin-secret-token"; // default admin token

  try {
    const res = await fetch(wuzapi + "/admin/users", {
      headers: { "Authorization": token },
      signal: AbortSignal.timeout(5000),
    });
    const responseData = await res.json().catch(() => ({}));
    const users = responseData.data || responseData.users || [];

    if (!Array.isArray(users) || users.length === 0) {
      return corsResponse(Response.json({ synced: 0, message: "No users found in wuzapi" }));
    }

    for (const u of users) {
      await db.prepare(
        `INSERT OR REPLACE INTO userbots (id, name, token, phone, connected, logged_in, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now'))`
      ).bind(
        u.id || "",
        u.name || u.id || "unknown",
        u.token || token,
        u.jid || u.Jid || "",
        u.connected ? 1 : 0,
        u.loggedIn || u.logged_in ? 1 : 0
      ).run().catch(() => {});
    }

    return corsResponse(Response.json({ synced: users.length, message: `Synced ${users.length} bot(s)` }));
  } catch (e) {
    return corsResponse(Response.json(
      { error: "SYNC_FAILED", message: "Cannot reach wuzapi: " + e.message },
      { status: 500 }
    ));
  }
}

/**
 * GET /api/keys — list all API keys (requires admin auth)
 */
async function handleListKeys(request, db) {
  const token = request.headers.get("X-Admin-Password") || "";
  const valid = await validateApiKey(db, token);
  if (!valid) {
    return corsResponse(Response.json({ error: "UNAUTHORIZED" }, { status: 401 }));
  }

  try {
    const { results } = await db.prepare(
      "SELECT id, key, name, role, active, last_used, created_at FROM api_keys ORDER BY created_at DESC"
    ).all();

    // Mask keys for security — show only last 4 chars
    const keys = results.map(k => ({
      id: k.id,
      key_masked: "●●●●" + k.key.slice(-4),
      name: k.name,
      role: k.role,
      active: !!k.active,
      last_used: k.last_used || "never",
      created_at: k.created_at,
    }));

    return corsResponse(Response.json({ keys }));
  } catch (e) {
    return corsResponse(Response.json({ error: "DB_ERROR", message: e.message }, { status: 500 }));
  }
}

/**
 * POST /api/keys — create a new API key (requires admin auth)
 * Body: { "name": "My Key", "role": "admin"|"send-only" }
 */
async function handleCreateKey(request, db) {
  const token = request.headers.get("X-Admin-Password") || "";
  const valid = await validateApiKey(db, token);
  if (!valid) {
    return corsResponse(Response.json({ error: "UNAUTHORIZED" }, { status: 401 }));
  }

  const body = await request.json().catch(() => ({}));
  const name = (body.name || "Unnamed Key").trim();
  const role = body.role === "send-only" ? "send-only" : "admin";

  // Generate a random 32-char API key
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const randomBytes = new Uint8Array(32);
  crypto.getRandomValues(randomBytes);
  const newKey = Array.from(randomBytes).map(b => chars[b % chars.length]).join("");

  try {
    await db.prepare(
      "INSERT INTO api_keys (key, name, role, active, created_by) VALUES (?1, ?2, ?3, 1, ?4)"
    ).bind(newKey, name, role, token).run();

    return corsResponse(Response.json({
      key: newKey,
      name,
      role,
      message: "Store this key safely — it won't be shown again.",
    }, { status: 201 }));
  } catch (e) {
    return corsResponse(Response.json({ error: "DB_ERROR", message: e.message }, { status: 500 }));
  }
}

/**
 * DELETE /api/keys/:id — revoke an API key (requires admin auth)
 */
async function handleDeleteKey(request, db, keyId) {
  const token = request.headers.get("X-Admin-Password") || "";
  const valid = await validateApiKey(db, token);
  if (!valid) {
    return corsResponse(Response.json({ error: "UNAUTHORIZED" }, { status: 401 }));
  }

  try {
    await db.prepare(
      "UPDATE api_keys SET active = 0 WHERE id = ?1"
    ).bind(parseInt(keyId)).run();

    return corsResponse(Response.json({ status: "revoked", id: parseInt(keyId) }));
  } catch (e) {
    return corsResponse(Response.json({ error: "DB_ERROR", message: e.message }, { status: 500 }));
  }
}

/**
 * POST /api/incoming-message — webhook from wuzapi
 * Validates HMAC signature, parses WhatsApp message, stores in D1.
 */
async function handleIncomingWebhook(request, env, db) {
  const body = await request.text().catch(() => "");
  const signature = request.headers.get("X-Wuzapi-Signature") || "";

  // Validate HMAC if key is configured
  const hmacKey = env.WUZAPI_HMAC_KEY;
  if (hmacKey) {
    const valid = await verifyHmac(body, signature, hmacKey);
    if (!valid) {
      return corsResponse(Response.json(
        { error: "INVALID_SIGNATURE" },
        { status: 401 }
      ));
    }
  }

  let outer, event, payload;
  try {
    outer = JSON.parse(body);
    // wuzapi wraps events in: {"instanceName":"...","jsonData":"...","userID":"..."}
    // The jsonData field is a JSON string containing the actual event
    if (outer.jsonData) {
      const inner = JSON.parse(outer.jsonData);
      event = inner.event || inner.type || "";
      payload = inner.data || inner;
    } else {
      // Fallback: direct format (for testing)
      event = outer.event || "";
      payload = outer.data || outer;
    }
  } catch {
    return corsResponse(Response.json({ error: "INVALID_JSON" }, { status: 400 }));
  }

  // Only process Message events (skip QR, code, etc.)
  if (event === "Message") {
    try {
      const info = payload.Info || payload;
      const message = payload.Message || payload;
      const msgSource = info.MessageSource || {};

      const jid = msgSource.Chat || msgSource.Sender || "";
      const text = message.Conversation
        || (message.ExtendedTextMessage && message.ExtendedTextMessage.Text)
        || "";
      const msgId = info.ID || "";
      const timestamp = info.Timestamp || "";
      const fromMe = msgSource.IsFromMe || false;
      const sender = msgSource.Sender || "";
      const pushName = msgSource.PushName || "";
      const userbotName = outer.instanceName || pushName || jid.split("@")[0];

      if (jid && text && !fromMe) {
        await db.prepare(
          "INSERT OR IGNORE INTO messages (userbot_name, phone, text, direction, status, created_at) VALUES (?1, ?2, ?3, 'in', 'delivered', ?4)"
        ).bind(
          userbotName,
          sender || jid,
          text,
          timestamp || new Date().toISOString()
        ).run().catch(() => {});
      }
    } catch (e) {
      console.error("[webhook] Parse error:", e.message);
    }
  }

  if (event === "HistorySync") {
    try {
      const conversations = payload.Conversations || payload.conversations || [];
      for (const conv of conversations) {
        const convJid = conv.JID || conv.jid || "";
        const messages = conv.Messages || conv.messages || [];
        for (const msg of messages) {
          const info = msg.Info || msg;
          const message = msg.Message || msg;
          const msgSource = info.MessageSource || {};
          const text = message.Conversation
            || (message.ExtendedTextMessage && message.ExtendedTextMessage.Text)
            || "";
          if (text && msgSource.Chat) {
            await db.prepare(
              "INSERT OR IGNORE INTO messages (userbot_name, phone, text, direction, status, created_at) VALUES (?1, ?2, ?3, 'in', 'delivered', ?4)"
            ).bind(
              outer.instanceName || msgSource.PushName || convJid.split("@")[0],
              msgSource.Sender || convJid,
              text,
              info.Timestamp || new Date().toISOString()
            ).run().catch(() => {});
          }
        }
      }
    } catch (e) {
      console.error("[webhook] HistorySync error:", e.message);
    }
  }

  return corsResponse(Response.json({ ok: true }));
}

// ── HELPERS ──

/**
 * Validate API key against D1.
 */
async function validateApiKey(db, key) {
  if (!db || !key) return false;
  try {
    const result = await db.prepare(
      "SELECT key, role FROM api_keys WHERE key = ?1 AND active = 1"
    ).bind(key).first();
    if (result) {
      // Track usage
      await db.prepare(
        "UPDATE api_keys SET last_used = datetime('now') WHERE key = ?1"
      ).bind(key).run().catch(() => {});
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Verify HMAC-SHA256 signature from wuzapi webhook.
 */
async function verifyHmac(body, signature, key) {
  if (!signature || !key) return true; // skip if not configured
  try {
    const encoder = new TextEncoder();
    const keyData = await crypto.subtle.importKey(
      "raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]
    );
    const sigBytes = hexToBytes(signature.replace("sha256=", ""));
    return await crypto.subtle.verify(
      "HMAC", keyData, sigBytes, encoder.encode(body)
    );
  } catch {
    return false;
  }
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function htmlResponse(html) {
  return corsResponse(new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" },
  }));
}

function corsResponse(response) {
  const res = response || new Response(null, { status: 204 });
  res.headers.set("Access-Control-Allow-Origin", "*");
  res.headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.headers.set("Access-Control-Allow-Headers", "Content-Type, X-Admin-Password, X-API-Key");
  return res;
}
