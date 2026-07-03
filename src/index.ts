/**
 * WhatsApp Cloudflare Workers v2
 *
 * Architecture:
 * ┌─────────────┐     ┌──────────────────┐     ┌─────────────┐
 * │  HTTP API   │────▶│  Cloudflare Queue │────▶│  Durable     │
 * │  (fetch)    │     │  (serialized)     │     │  Object      │
 * └─────────────┘     └──────────────────┘     │  (persistent │
 *                                               │   WebSocket) │
 *                                               └──────┬──────┘
 *                                                      │
 *                                               ┌──────▼──────┐
 *                                               │  WhatsApp   │
 *                                               │  Servers    │
 *                                               └─────────────┘
 *
 * Security:
 * - Admin endpoints (register, delete): require X-Admin-Password header
 * - Send-message: requires X-API-Key header
 * - Read endpoints (status, messages): public
 */

import type { Env, OutboxMessage } from "./types"
import { AppError } from "./types"
import { handleRegisterWhatsApp } from "./api/register"
import { handleSendMessage, processQueuedMessage } from "./api/send-message"
import {
  handleStatus,
  handleListUserBots,
  handleDeleteUserBot,
  handlePollMessages,
  handleSetWebhook,
  handleDeleteWebhook,
} from "./api/status"

// @ts-ignore — wrangler handles .html imports
import registerHtml from "./html/register.html"
// @ts-ignore
import sendMessageHtml from "./html/send-message.html"

// ── AUTH MIDDLEWARE ──

/**
 * Validate admin password from X-Admin-Password header.
 * Used for sensitive operations: registration, deletion.
 */
function requireAdmin(request: Request, env: Env): void {
  const password = request.headers.get("X-Admin-Password") || ""
  if (password !== env.ADMIN_PASSWORD) {
    throw new AppError("Invalid or missing admin password", 401, "UNAUTHORIZED")
  }
}

/**
 * Validate API key from X-API-Key header.
 * Used for message sending.
 */
function requireApiKey(request: Request, env: Env): void {
  const apiKey = request.headers.get("X-API-Key") || ""
  // API key is the same as admin password for simplicity
  // In production, use a separate key
  if (apiKey !== env.ADMIN_PASSWORD) {
    throw new AppError("Invalid or missing API key", 401, "UNAUTHORIZED")
  }
}

// ── FETCH HANDLER ──

export default {
  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<Response> {
    // Set admin password default if not configured
    if (!env.ADMIN_PASSWORD) {
      console.warn(
        "⚠️  ADMIN_PASSWORD not set! Using default. Set with: wrangler secret put ADMIN_PASSWORD"
      )
      env.ADMIN_PASSWORD = "changeme"
    }

    const url = new URL(request.url)
    const pathname = url.pathname
    const method = request.method

    // CORS preflight
    if (method === "OPTIONS") {
      return corsResponse()
    }

    try {
      // ── Static Pages (public) ──

      if (
        (pathname === "/" || pathname === "/site/register-whatsapp") &&
        method === "GET"
      ) {
        return htmlResponse(registerHtml)
      }

      if (pathname.startsWith("/site/send-message") && method === "GET") {
        return htmlResponse(sendMessageHtml)
      }

      // ── Health Check (public) ──
      if (pathname === "/api/health" && method === "GET") {
        return corsResponse(
          Response.json({
            status: "ok",
            timestamp: new Date().toISOString(),
            version: "2.0.0",
          })
        )
      }

      // ── API: Register (admin auth) ──
      if (pathname.startsWith("/api/register-whatsapp") && method === "POST") {
        requireAdmin(request, env)
        const res = await handleRegisterWhatsApp(request, env)
        return corsResponse(res)
      }

      // ── API: Send Message (API key auth) ──
      if (pathname.startsWith("/api/send-message") && method === "POST") {
        requireApiKey(request, env)
        const res = await handleSendMessage(request, env)
        return corsResponse(res)
      }

      // ── API: Status (public read) ──
      const statusMatch = pathname.match(/^\/api\/status\/([a-zA-Z0-9_-]+)$/)
      if (statusMatch && method === "GET") {
        const res = await handleStatus(request, env, statusMatch[1])
        return corsResponse(res)
      }

      // ── API: Poll Messages (public read) ──
      const messagesMatch = pathname.match(
        /^\/api\/messages\/([a-zA-Z0-9_-]+)$/
      )
      if (messagesMatch && method === "GET") {
        const res = await handlePollMessages(request, env, messagesMatch[1])
        return corsResponse(res)
      }

      // ── API: Webhook Config (admin auth) ──
      const webhookMatch = pathname.match(
        /^\/api\/webhook\/([a-zA-Z0-9_-]+)$/
      )
      if (webhookMatch) {
        if (method === "PUT") {
          requireAdmin(request, env)
          const res = await handleSetWebhook(request, env, webhookMatch[1])
          return corsResponse(res)
        }
        if (method === "DELETE") {
          requireAdmin(request, env)
          const res = await handleDeleteWebhook(request, env, webhookMatch[1])
          return corsResponse(res)
        }
      }

      // ── API: List UserBots (public read) ──
      if (pathname === "/api/userbots" && method === "GET") {
        const res = await handleListUserBots(request, env)
        return corsResponse(res)
      }

      // ── API: Delete UserBot (admin auth) ──
      const deleteMatch = pathname.match(
        /^\/api\/userbots\/([a-zA-Z0-9_-]+)$/
      )
      if (deleteMatch && method === "DELETE") {
        requireAdmin(request, env)
        const res = await handleDeleteUserBot(request, env, deleteMatch[1])
        return corsResponse(res)
      }

      // ── 404 ──
      return corsResponse(new AppError("Not found", 404, "NOT_FOUND").toResponse())
    } catch (error) {
      console.error("[fetch] Unhandled error:", error)

      if (error instanceof AppError) {
        return corsResponse(error.toResponse())
      }

      return corsResponse(
        Response.json(
          {
            error: "INTERNAL_ERROR",
            message: (error as Error).message || "Internal server error",
          },
          { status: 500 }
        )
      )
    }
  },

  // ── QUEUE CONSUMER ──

  async queue(batch: MessageBatch<OutboxMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        const success = await processQueuedMessage(message.body, env)
        if (success) {
          message.ack()
        } else {
          message.retry({ delaySeconds: 5 })
        }
      } catch (error) {
        console.error(
          `[Queue] Failed to process message for ${message.body.userBot}:`,
          error
        )
        message.retry({ delaySeconds: 10 })
      }
    }
  },
}

// ── HELPERS ──

function htmlResponse(html: string): Response {
  return corsResponse(
    new Response(html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
      },
    })
  )
}

function corsResponse(response?: Response): Response {
  const res = response || new Response(null, { status: 204 })
  res.headers.set("Access-Control-Allow-Origin", "*")
  res.headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
  res.headers.set("Access-Control-Allow-Headers", "Content-Type, X-Admin-Password, X-API-Key")
  return res
}
