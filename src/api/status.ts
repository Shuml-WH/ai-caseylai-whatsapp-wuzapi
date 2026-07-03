import type { Env } from "../types"
import { AppError } from "../types"
import { AuthStore } from "../auth-store"

/**
 * GET /api/status/:userBot
 */
export async function handleStatus(
  request: Request,
  env: Env,
  userBot: string
): Promise<Response> {
  if (!userBot) {
    throw new AppError("Missing userBot parameter", 400, "BAD_REQUEST")
  }

  try {
    const doId = env.WHATSAPP_SESSION.idFromName(userBot)
    const stub = env.WHATSAPP_SESSION.get(doId)
    const status = await stub.getStatus()
    return Response.json(status, { status: 200 })
  } catch (error) {
    throw new AppError(
      `Failed to get status: ${(error as Error).message}`,
      500,
      "STATUS_FAILED"
    )
  }
}

/**
 * GET /api/messages/:userBot
 *
 * Polling endpoint — retrieves and clears pending incoming messages.
 * Client should call this periodically (e.g., every 2-5 seconds).
 */
export async function handlePollMessages(
  request: Request,
  env: Env,
  userBot: string
): Promise<Response> {
  if (!userBot) {
    throw new AppError("Missing userBot parameter", 400, "BAD_REQUEST")
  }

  try {
    const doId = env.WHATSAPP_SESSION.idFromName(userBot)
    const stub = env.WHATSAPP_SESSION.get(doId)
    const messages = await stub.getPendingMessages()

    return Response.json(
      {
        userBot,
        count: messages.length,
        messages,
      },
      { status: 200 }
    )
  } catch (error) {
    throw new AppError(
      `Failed to fetch messages: ${(error as Error).message}`,
      500,
      "POLL_FAILED"
    )
  }
}

/**
 * PUT /api/webhook/:userBot
 *
 * Configure webhook URL for real-time message delivery.
 * Body: { url: "https://...", secret?: "hmac-secret" }
 */
export async function handleSetWebhook(
  request: Request,
  env: Env,
  userBot: string
): Promise<Response> {
  if (!userBot) {
    throw new AppError("Missing userBot parameter", 400, "BAD_REQUEST")
  }

  const body = (await request.json()) as {
    url: string
    secret?: string
    enabled?: boolean
  }

  if (!body.url) {
    throw new AppError("Missing webhook URL", 400, "BAD_REQUEST")
  }

  try {
    const doId = env.WHATSAPP_SESSION.idFromName(userBot)
    const stub = env.WHATSAPP_SESSION.get(doId)
    const result = await stub.setWebhook({
      url: body.url,
      secret: body.secret,
      enabled: body.enabled !== false,
    })

    return Response.json(result, { status: 200 })
  } catch (error) {
    throw new AppError(
      `Failed to set webhook: ${(error as Error).message}`,
      500,
      "WEBHOOK_FAILED"
    )
  }
}

/**
 * DELETE /api/webhook/:userBot
 *
 * Disable webhook delivery.
 */
export async function handleDeleteWebhook(
  request: Request,
  env: Env,
  userBot: string
): Promise<Response> {
  if (!userBot) {
    throw new AppError("Missing userBot parameter", 400, "BAD_REQUEST")
  }

  try {
    const doId = env.WHATSAPP_SESSION.idFromName(userBot)
    const stub = env.WHATSAPP_SESSION.get(doId)
    await stub.setWebhook({ url: "", enabled: false })

    return Response.json({ success: true }, { status: 200 })
  } catch (error) {
    throw new AppError(
      `Failed to disable webhook: ${(error as Error).message}`,
      500,
      "WEBHOOK_FAILED"
    )
  }
}

/**
 * GET /api/userbots
 */
export async function handleListUserBots(
  _request: Request,
  env: Env
): Promise<Response> {
  try {
    const userBots = await AuthStore.listUserBots(env.WHATSAPP_STORAGE)
    return Response.json({ userBots }, { status: 200 })
  } catch (error) {
    throw new AppError(
      `Failed to list userBots: ${(error as Error).message}`,
      500,
      "LIST_FAILED"
    )
  }
}

/**
 * DELETE /api/userbots/:userBot
 */
export async function handleDeleteUserBot(
  request: Request,
  env: Env,
  userBot: string
): Promise<Response> {
  if (!userBot) {
    throw new AppError("Missing userBot parameter", 400, "BAD_REQUEST")
  }

  try {
    const doId = env.WHATSAPP_SESSION.idFromName(userBot)
    const stub = env.WHATSAPP_SESSION.get(doId)
    await stub.terminateSession()
  } catch {
    // DO might not exist — that's fine
  }

  await AuthStore.deleteUserBot(env.WHATSAPP_STORAGE, userBot)
  return Response.json({ status: "deleted", userBot }, { status: 200 })
}
