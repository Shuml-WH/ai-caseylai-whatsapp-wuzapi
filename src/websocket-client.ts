/**
 * Request-scoped WebSocket client — NO global variables.
 *
 * Key fixes vs. original:
 * - All state is instance-scoped (not module-global)
 * - Proper cleanup on close
 * - Configurable connection timeout
 * - Event emitter pattern preserved
 */

export class WebSocketClient {
  private socket: WebSocket | null = null
  private url: URL
  private origin: string
  private connectTimeoutMs: number
  private maxConnectionTimeMs: number
  private timeMaxOpenSocket: ReturnType<typeof setTimeout> | null = null

  // Event listener storage (replaces Node EventEmitter)
  private listeners: Map<string, Set<(...args: any[]) => void>> = new Map()

  constructor(options: {
    url: string
    origin?: string
    connectTimeoutMs?: number
    maxConnectionTimeMs?: number
  }) {
    this.url = new URL(options.url)
    this.origin = options.origin || "https://web.whatsapp.com"
    this.connectTimeoutMs = options.connectTimeoutMs || 20000
    this.maxConnectionTimeMs = options.maxConnectionTimeMs || 50000
  }

  // ── CONNECTION STATE ──

  get isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN
  }

  get isClosed(): boolean {
    return !this.socket || this.socket.readyState === WebSocket.CLOSED
  }

  get isClosing(): boolean {
    return !this.socket || this.socket.readyState === WebSocket.CLOSING
  }

  get isConnecting(): boolean {
    return this.socket?.readyState === WebSocket.CONNECTING
  }

  // ── CONNECT ──

  async connect(): Promise<void> {
    if (this.socket) {
      throw new Error("Already connected — close first before reconnecting")
    }

    // Convert wss:// to https:// for Cloudflare fetch-based WebSocket pair
    const fetchUrl = this.url.href.replace("wss://", "https://")

    const response = (await fetch(fetchUrl, {
      headers: {
        Origin: this.origin,
        Upgrade: "websocket",
      },
    })) as Response & { webSocket: WebSocket | null }

    const wsPair = response.webSocket
    if (!wsPair) {
      throw new Error(
        `Failed to establish WebSocket: no webSocket in response. ` +
        `Status: ${response.status}. The upstream server may not support HTTP WebSocket upgrade.`
      )
    }

    this.socket = wsPair

    // Set max connection lifetime — auto-close after N ms
    this.timeMaxOpenSocket = setTimeout(() => {
      this.socket?.close()
    }, this.maxConnectionTimeMs)

    // Wire up event listeners → our custom emitter
    this.socket.addEventListener("open", (event) => this.emit("open", event))
    this.socket.addEventListener("close", (event) => {
      this.cleanup()
      this.emit("close", event)
    })
    this.socket.addEventListener("error", (event) => this.emit("error", event))

    this.socket.addEventListener("message", (event) => {
      // Normalize data: Cloudflare WS may give ArrayBuffer or string
      let data = event.data
      if (data instanceof ArrayBuffer) {
        data = Buffer.from(data)
      }
      this.emit("message", data)
    })

    // Accept the WebSocket pair (required for Cloudflare Workers)
    if (this.socket.readyState === WebSocket.OPEN) {
      ;(this.socket as WebSocket & { accept(): void }).accept()
      this.emit("open", new Event("open"))
    } else {
      this.emit("error", new Error("WebSocket connection failed"))
    }
  }

  // ── CLOSE ──

  async close(): Promise<void> {
    this.cleanup()
    if (this.socket && !this.isClosed) {
      this.socket.close()
    }
    this.socket = null
  }

  private cleanup(): void {
    if (this.timeMaxOpenSocket) {
      clearTimeout(this.timeMaxOpenSocket)
      this.timeMaxOpenSocket = null
    }
  }

  // ── SEND ──

  send(data: string | Uint8Array): boolean {
    if (!this.socket || this.isClosed) {
      return false
    }
    this.socket.send(data)
    return true
  }

  // ── EVENT EMITTER ──

  on(event: string, listener: (...args: any[]) => void): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set())
    }
    this.listeners.get(event)!.add(listener)
  }

  off(event: string, listener: (...args: any[]) => void): void {
    this.listeners.get(event)?.delete(listener)
    if (this.listeners.get(event)?.size === 0) {
      this.listeners.delete(event)
    }
  }

  emit(event: string, ...args: any[]): boolean {
    const eventListeners = this.listeners.get(event)
    if (!eventListeners || eventListeners.size === 0) {
      return false
    }
    eventListeners.forEach((listener) => {
      try {
        listener(...args)
      } catch (err) {
        console.error(`[WebSocketClient] Error in '${event}' listener:`, err)
      }
    })
    return true
  }

  removeAllListeners(): void {
    this.listeners.clear()
  }
}
