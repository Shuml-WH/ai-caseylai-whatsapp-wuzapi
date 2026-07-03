import type { Env, SendMessageRequest, SendMessageResponse, OutboxMessage } from "../types"
import { AppError } from "../types"

/**
 * POST /api/send-message
 *
 * Accepts a send-message request and enqueues it to Cloudflare Queue.
 * Returns immediately with "queued" status — the actual send happens
 * asynchronously via the queue consumer.
 *
 * Why Queue instead of direct DO RPC?
 * - Prevents concurrent sends to the same userBot
 * - Provides natural rate limiting
 * - Survives Worker restarts (messages persist in queue)
 */
export async function handleSendMessage(
  request: Request,
  env: Env
): Promise<Response> {
  const body = (await request.json()) as SendMessageRequest

  if (!body.userBot || !body.phone || !body.message) {
    throw new AppError(
      "Missing required fields: userBot, phone, message",
      400,
      "BAD_REQUEST"
    )
  }

  // ── Validate phone number ──
  const phone = body.phone.replace(/[^0-9]/g, "")
  if (phone.length < 7 || phone.length > 15) {
    throw new AppError(
      "Invalid phone number format",
      400,
      "BAD_REQUEST"
    )
  }

  const userBot = body.userBot.trim()
  // Normalize newlines
  const message = body.message.replace(/\r?\n|\r/g, "\n")

  // ── Enqueue message ──
  const outboxMsg: OutboxMessage = {
    userBot: `userBot/${userBot}`,
    phone,
    message,
    submittedAt: new Date().toISOString(),
  }

  await env.WHATSAPP_OUTBOX.send(outboxMsg)

  const response: SendMessageResponse = {
    status: "queued",
    userBot,
    phone,
    queuedAt: new Date().toISOString(),
  }

  return Response.json(response, { status: 202 })
}

/**
 * Process a queued message (called by Queue consumer).
 */
export async function processQueuedMessage(
  msg: OutboxMessage,
  env: Env
): Promise<boolean> {
  try {
    // ── Get DO instance ──
    const userBotName = msg.userBot.replace("userBot/", "")
    const doId = env.WHATSAPP_SESSION.idFromName(userBotName)
    const stub = env.WHATSAPP_SESSION.get(doId)

    // ── Send via the persistent DO connection ──
    const result = await stub.sendMessage(msg.phone, msg.message)

    if (result.success) {
      console.log(`[Queue] Message sent to ${msg.phone} via ${msg.userBot}`)
      return true
    }

    console.error(
      `[Queue] Failed to send message to ${msg.phone}: ${result.error}`
    )
    return false
  } catch (error) {
    console.error(`[Queue] Error processing message:`, error)
    throw error // Let Queue retry
  }
}
