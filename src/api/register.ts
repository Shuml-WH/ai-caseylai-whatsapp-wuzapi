import type { Env } from "../types"
import { AppError } from "../types"
import { acquireLock, releaseLock } from "../locks"

/**
 * POST /api/register-whatsapp
 *
 * Requires: X-Admin-Password header (validated by middleware in index.ts)
 *
 * Registers a new userBot by creating a WhatsAppSession DO and returning
 * a QR code link for scanning.
 */
export async function handleRegisterWhatsApp(
  request: Request,
  env: Env
): Promise<Response> {
  const body = (await request.json()) as { userBot: string }

  if (!body.userBot) {
    throw new AppError("Missing userBot name", 400, "BAD_REQUEST")
  }

  const userBot = body.userBot.trim()
  if (!/^[a-zA-Z0-9_-]+$/.test(userBot)) {
    throw new AppError(
      "userBot name must only contain a-z, A-Z, 0-9, _, -",
      400,
      "BAD_REQUEST"
    )
  }

  // ── Acquire lock to prevent concurrent registration ──
  const locked = await acquireLock(env.WHATSAPP_LOCKS, userBot)
  if (!locked) {
    throw new AppError(
      "Registration already in progress for this userBot",
      409,
      "CONFLICT"
    )
  }

  try {
    const doId = env.WHATSAPP_SESSION.idFromName(userBot)
    const stub = env.WHATSAPP_SESSION.get(doId)

    const result = await stub.initSession()

    return Response.json(
      {
        link: result.link,
        userBot,
        status: "pending_scan",
      },
      { status: 200 }
    )
  } catch (error) {
    if (error instanceof AppError) throw error
    throw new AppError(
      `Registration failed: ${(error as Error).message}`,
      500,
      "REGISTRATION_FAILED"
    )
  } finally {
    await releaseLock(env.WHATSAPP_LOCKS, userBot)
  }
}
