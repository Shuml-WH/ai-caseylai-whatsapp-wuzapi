import { DurableObject } from "cloudflare:workers"
import type { R2Bucket } from "@cloudflare/workers-types"
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  proto,
  type WASocket,
} from "whatsapp-cloudflare-workers"
import P from "pino"
import NodeCache from "@cacheable/node-cache"
import type { Boom } from "@hapi/boom"
import { AuthStore } from "./auth-store"

/**
 * WhatsAppSession — Durable Object for persistent WhatsApp connections.
 *
 * Each userBot gets exactly ONE instance. The DO maintains a long-lived
 * WebSocket connection to WhatsApp, persists credentials and signal keys
 * via R2, and supports both sending AND receiving messages.
 *
 * Incoming message delivery:
 * - Webhook mode: POST each message to a configured webhook URL (real-time)
 * - Polling mode: Buffer in pendingMessages, retrieved via getPendingMessages()
 */

interface Env {
  WHATSAPP_STORAGE: R2Bucket
}

interface WebhookConfig {
  url: string
  secret?: string
  enabled: boolean
}

export class WhatsAppSession extends DurableObject<Env> {
  private sock: WASocket | null = null
  private authStore!: AuthStore
  private logger: ReturnType<typeof P>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private msgRetryCounterCache: any

  // Connection state tracking
  private connected: boolean = false
  private qrCode: string | null = null
  private lastActivity: Date | null = null
  private reconnectAttempts: number = 0
  private maxReconnectAttempts: number = 10

  // Incoming message buffer (for polling delivery)
  private pendingMessages: Array<{
    key: any
    message: any
    receivedAt: string
  }> = []

  // Webhook configuration
  private webhook: WebhookConfig = { url: "", enabled: false }
  private webhookFailures: number = 0
  private maxWebhookFailures: number = 5

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.msgRetryCounterCache = new NodeCache()
    this.logger = P({ timestamp: () => `,"time":"${new Date().toJSON()}"` })
    this.logger.level = "silent"
  }

  // ── PUBLIC RPC METHODS ──

  /**
   * Initialize connection to WhatsApp and return a QR code link.
   */
  async initSession(): Promise<{ link: string; status: string }> {
    if (this.sock?.user) {
      return { link: "", status: "already_connected" }
    }

    const userId = this.ctx.id.name || this.ctx.id.toString()
    this.authStore = new AuthStore(this.env.WHATSAPP_STORAGE, userId)
    await this.authStore.deleteCreds()

    try {
      const qrLink = await this.establishConnection(userId, true)
      return { link: qrLink, status: "pending_scan" }
    } catch (error: any) {
      this.logger.error({ err: error }, "Failed to connect")
      throw new Error(`Connection failed: ${error.message}`)
    }
  }

  /**
   * Send a message to a phone number.
   */
  async sendMessage(
    phone: string,
    message: string
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.sock?.user) {
      return { success: false, error: "Not connected. Register first." }
    }

    this.lastActivity = new Date()
    const jid = `${phone}@s.whatsapp.net`

    try {
      await this.sock.sendPresenceUpdate("composing", jid)
      await this.delay(2000 + Math.random() * 3000)
      await this.sock.sendPresenceUpdate("paused", jid)

      const result = await this.sendWithRetry(jid, { text: message })
      const success = (result?.status ?? 0) >= 1

      if (success) {
        this.logger.info(`Message sent to ${phone}`)
        return { success: true }
      }
      return { success: false, error: "Message status not >= 1" }
    } catch (error: any) {
      this.logger.error({ err: error, phone }, "Failed to send message")
      return { success: false, error: error.message }
    }
  }

  /**
   * Get current connection status.
   */
  async getStatus(): Promise<{
    connected: boolean
    user: string | null
    lastActivity: string | null
    reconnectAttempts: number
    pendingMessages: number
    webhook: { url: string; enabled: boolean }
  }> {
    return {
      connected: this.connected,
      user: this.sock?.user?.id || null,
      lastActivity: this.lastActivity?.toISOString() || null,
      reconnectAttempts: this.reconnectAttempts,
      pendingMessages: this.pendingMessages.length,
      webhook: {
        url: this.webhook.enabled ? this.webhook.url : "",
        enabled: this.webhook.enabled,
      },
    }
  }

  /**
   * Get pending incoming messages (polling mode).
   * Returns and clears the buffer.
   */
  async getPendingMessages(): Promise<
    Array<{ key: any; message: any; receivedAt: string }>
  > {
    const messages = [...this.pendingMessages]
    this.pendingMessages = []
    return messages
  }

  /**
   * Configure webhook for real-time message delivery.
   */
  async setWebhook(config: WebhookConfig): Promise<{ success: boolean }> {
    if (!config.url || !config.url.startsWith("https://")) {
      throw new Error("Webhook URL must start with https://")
    }
    this.webhook = {
      url: config.url,
      secret: config.secret,
      enabled: config.enabled !== false,
    }
    this.webhookFailures = 0
    this.logger.info(`Webhook configured: ${config.url}`)
    return { success: true }
  }

  /**
   * Disconnect and clean up.
   */
  async terminateSession(): Promise<void> {
    if (this.sock) {
      try {
        this.sock.ws.close()
        this.sock.end(new Error("User requested disconnect") as any)
      } catch {}
      this.sock = null
    }
    this.connected = false
    this.qrCode = null
    this.reconnectAttempts = 0
  }

  // ── CONNECTION MANAGEMENT ──

  private async establishConnection(
    userId: string,
    _isRegistration: boolean
  ): Promise<string> {
    const { state, saveCreds } = await useMultiFileAuthState(
      `userBot/${userId}`,
      this.env.WHATSAPP_STORAGE
    )

    const { version } = await fetchLatestBaileysVersion()
    this.logger.info(`Using WA v${version.join(".")}`)

    let waitForLinkResolver!: (value: string) => void
    const waitForLink = new Promise<string>((resolve) => {
      waitForLinkResolver = resolve
    })

    this.sock = makeWASocket({
      version,
      logger: this.logger,
      printQRInTerminal: false,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, this.logger),
      },
      msgRetryCounterCache: this.msgRetryCounterCache,
      generateHighQualityLinkPreview: true,
    })

    this.sock.ev.process(async (events) => {
      if (events["connection.update"]) {
        const update = events["connection.update"]
        const { connection, lastDisconnect, qr } = update

        if (qr) {
          this.qrCode = qr
          waitForLinkResolver(qr)
        }

        if (connection === "open") {
          this.connected = true
          this.reconnectAttempts = 0
          this.logger.info("WhatsApp connection opened")
        }

        if (connection === "close") {
          this.connected = false
          const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode

          if (statusCode === DisconnectReason.loggedOut) {
            this.logger.info("Logged out — will not reconnect")
            await this.authStore.deleteCreds()
          } else if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++
            const backoff = Math.min(
              1000 * Math.pow(2, this.reconnectAttempts),
              30000
            )
            this.logger.info(
              `Reconnecting in ${backoff}ms (attempt ${this.reconnectAttempts})`
            )
            await this.delay(backoff)
            try {
              const link = await this.establishConnection(userId, false)
              if (!this.connected && link) {
                this.qrCode = link
              }
            } catch (err) {
              this.logger.error({ err }, "Reconnection failed")
            }
          } else {
            this.logger.error("Max reconnection attempts reached")
          }
        }
      }

      // Incoming messages — deliver via webhook OR buffer for polling
      if (events["messages.upsert"]) {
        const { messages } = events["messages.upsert"]
        for (const msg of messages) {
          if (!msg.key.fromMe) {
            const incoming = {
              key: msg.key,
              message: msg.message,
              receivedAt: new Date().toISOString(),
            }

            // Try webhook first
            if (this.webhook.enabled && this.webhookFailures < this.maxWebhookFailures) {
              this.deliverViaWebhook(incoming)
            }

            // Always buffer (fallback for polling even when webhook fails)
            this.pendingMessages.push(incoming)
          }
        }
        if (this.pendingMessages.length > 100) {
          this.pendingMessages = this.pendingMessages.slice(-50)
        }
      }

      if (events["creds.update"]) {
        await saveCreds()
      }
    })

    return waitForLink
  }

  // ── WEBHOOK DELIVERY ──

  private async deliverViaWebhook(msg: {
    key: any
    message: any
    receivedAt: string
  }): Promise<void> {
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "X-WhatsApp-Event": "message",
      }

      // Add HMAC signature if secret is configured
      if (this.webhook.secret) {
        const payload = JSON.stringify(msg)
        const encoder = new TextEncoder()
        const key = await crypto.subtle.importKey(
          "raw",
          encoder.encode(this.webhook.secret),
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign"]
        )
        const signature = await crypto.subtle.sign(
          "HMAC",
          key,
          encoder.encode(payload)
        )
        headers["X-Webhook-Signature"] = btoa(
          String.fromCharCode(...new Uint8Array(signature))
        )
      }

      const response = await fetch(this.webhook.url, {
        method: "POST",
        headers,
        body: JSON.stringify(msg),
      })

      if (!response.ok) {
        this.webhookFailures++
        this.logger.warn(
          `Webhook delivery failed (${response.status}), failures: ${this.webhookFailures}`
        )
      } else {
        this.webhookFailures = 0
      }
    } catch (error) {
      this.webhookFailures++
      this.logger.warn(
        `Webhook delivery error, failures: ${this.webhookFailures}`
      )

      // Auto-disable after too many failures
      if (this.webhookFailures >= this.maxWebhookFailures) {
        this.webhook.enabled = false
        this.logger.error(
          `Webhook disabled after ${this.maxWebhookFailures} consecutive failures`
        )
      }
    }
  }

  // ── SEND WITH RETRY ──

  private async sendWithRetry(
    jid: string,
    content: { text: string },
    maxRetries: number = 5
  ): Promise<any> {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const response = await this.sock!.sendMessage(jid, content)
        if (response && typeof response === "object" && "status" in response) {
          if ((response as { status: number }).status >= 1) return response
        } else if (response) {
          return response
        }
        if (attempt < maxRetries - 1) {
          const backoff = Math.min(2000 * Math.pow(2, attempt), 30000)
          await this.delay(backoff + Math.random() * 1000)
        }
      } catch (error) {
        if (attempt === maxRetries - 1) throw error
        const backoff = 2000 * Math.pow(2, attempt)
        await this.delay(backoff + Math.random() * 500)
      }
    }
    return null
  }

  // ── UTILITY ──

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
