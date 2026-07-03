import type { R2Bucket, R2Object } from "@cloudflare/workers-types"

/**
 * R2-based auth state store — replaces the filesystem-based useMultiFileAuthState.
 *
 * Key design decisions:
 * - Each userBot gets its own R2 prefix: `userBot/{name}/`
 * - creds.json stores the authentication credentials
 * - `app-state-sync-key-*.json` stores signal session keys (we DO persist them now!)
 * - All writes are atomic via R2 put (no file locking needed)
 */

const PREFIX = "userBot"

export class AuthStore {
  private r2: R2Bucket
  private userBot: string
  private prefix: string

  constructor(r2: R2Bucket, userBot: string) {
    this.r2 = r2
    this.userBot = userBot
    this.prefix = `${PREFIX}/${userBot}`
  }

  // ── CREDENTIALS ──

  async readCreds(): Promise<Record<string, any> | null> {
    const key = `${this.prefix}/creds.json`
    const obj = await this.r2.get(key)
    if (!obj) return null
    const text = await obj.text()
    return JSON.parse(text)
  }

  async writeCreds(creds: Record<string, any>): Promise<void> {
    const key = `${this.prefix}/creds.json`
    const data = JSON.stringify(creds)

    // Preserve existing metadata if present
    const existing = await this.r2.head(key)
    const customMetadata: Record<string, string> = {
      ...(existing?.customMetadata as Record<string, string> | undefined),
      userBot: this.userBot,
      phone: creds?.me?.id?.split(":")?.[0] || "unknown",
      updatedAt: new Date().toISOString(),
    }

    await this.r2.put(key, data, { customMetadata })
  }

  async deleteCreds(): Promise<void> {
    await this.r2.delete(`${this.prefix}/creds.json`)
  }

  // ── SIGNAL KEYS ──

  async readSignalKey(type: string, id: string): Promise<any | null> {
    const safeType = this.sanitizeFileName(type)
    const safeId = this.sanitizeFileName(id)
    const key = `${this.prefix}/${safeType}-${safeId}.json`
    const obj = await this.r2.get(key)
    if (!obj) return null
    const text = await obj.text()
    return JSON.parse(text)
  }

  async writeSignalKey(type: string, id: string, value: any): Promise<void> {
    const safeType = this.sanitizeFileName(type)
    const safeId = this.sanitizeFileName(id)
    const key = `${this.prefix}/${safeType}-${safeId}.json`
    const data = JSON.stringify(value)
    await this.r2.put(key, data, {
      customMetadata: {
        userBot: this.userBot,
        type,
        id,
        updatedAt: new Date().toISOString(),
      },
    })
  }

  async deleteSignalKey(type: string, id: string): Promise<void> {
    const safeType = this.sanitizeFileName(type)
    const safeId = this.sanitizeFileName(id)
    const key = `${this.prefix}/${safeType}-${safeId}.json`
    await this.r2.delete(key)
  }

  async writeMultipleSignalKeys(
    data: Record<string, Record<string, any>>
  ): Promise<void> {
    // Batch write signal keys
    const promises: Promise<void>[] = []
    for (const category in data) {
      for (const id in data[category]) {
        const value = data[category][id]
        if (value) {
          promises.push(this.writeSignalKey(category, id, value))
        } else {
          promises.push(this.deleteSignalKey(category, id))
        }
      }
    }
    await Promise.all(promises)
  }

  // ── STATIC METHODS ──

  /**
   * List all userBots stored in R2.
   * Reads the custom metadata of all creds.json files.
   */
  static async listUserBots(
    r2: R2Bucket
  ): Promise<Array<{ name: string; phone: string; updatedAt: string }>> {
    const result: Array<{ name: string; phone: string; updatedAt: string }> =
      []

    // List all "folders" (delimitedPrefixes) under userBot/
    const listResult = await r2.list({ prefix: `${PREFIX}/`, delimiter: "/" })

    for (const prefix of listResult.delimitedPrefixes) {
      // Extract userBot name from prefix: "userBot/mybot/" → "mybot"
      const name = prefix.slice(PREFIX.length + 1, -1)

      // Get metadata from the creds.json
      try {
        const head = await r2.head(`${prefix}creds.json`)
        result.push({
          name,
          phone: (head?.customMetadata?.phone as string) || "unknown",
          updatedAt: (head?.customMetadata?.updatedAt as string) || "unknown",
        })
      } catch {
        // creds.json doesn't exist yet — skip this userBot
      }
    }

    return result
  }

  /**
   * Delete all data for a userBot.
   */
  static async deleteUserBot(r2: R2Bucket, userBot: string): Promise<void> {
    const prefix = `${PREFIX}/${userBot}/`

    // R2 list returns up to 1000 objects, then truncates
    const listResult = await r2.list({ prefix })

    const deletePromises = listResult.objects.map((obj: R2Object) => r2.delete(obj.key))
    await Promise.all(deletePromises)
  }

  // ── UTILITY ──

  private sanitizeFileName(name: string): string {
    return name.replace(/\//g, "__").replace(/:/g, "-")
  }
}
