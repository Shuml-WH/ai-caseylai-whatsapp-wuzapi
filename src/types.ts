import type { R2Bucket, DurableObjectNamespace, Queue, KVNamespace } from "@cloudflare/workers-types"

// ── Environment Bindings ──
export interface Env {
  // R2 storage for auth state
  WHATSAPP_STORAGE: R2Bucket

  // KV for distributed locks
  WHATSAPP_LOCKS: KVNamespace

  // Durable Object for persistent WhatsApp sessions
  WHATSAPP_SESSION: DurableObjectNamespace<import("./whatsapp-session").WhatsAppSession>

  // Queue for message sending
  WHATSAPP_OUTBOX: Queue<OutboxMessage>

  // Environment variables
  ADMIN_PASSWORD?: string
}

// ── Queue Message ──
export interface OutboxMessage {
  userBot: string
  phone: string
  message: string
  /** ISO timestamp when the message was submitted */
  submittedAt: string
}

// ── API Request/Response ──
export interface RegisterRequest {
  userBot: string
  adminPassword?: string
}

export interface RegisterResponse {
  link: string
  userBot: string
  status: "pending_scan" | "connected"
}

export interface SendMessageRequest {
  userBot: string
  phone: string
  message: string
}

export interface SendMessageResponse {
  status: "queued" | "sent" | "failed"
  userBot: string
  phone: string
  queuedAt: string
}

export interface StatusResponse {
  userBot: string
  connected: boolean
  lastActivity: string | null
}

// ── Auth State (persisted in R2) ──
export interface AuthStateData {
  creds: Record<string, any>
  signalKeys: Record<string, Record<string, any>>
  updatedAt: string
}

// ── Lock ──
export interface LockInfo {
  holder: string
  acquiredAt: string
  ttl: number
}

// ── Error ──
export class AppError extends Error {
  constructor(
    message: string,
    public statusCode: number = 500,
    public code: string = "INTERNAL_ERROR"
  ) {
    super(message)
    this.name = "AppError"
  }

  toResponse(): Response {
    return Response.json(
      { error: this.code, message: this.message },
      { status: this.statusCode }
    )
  }
}
