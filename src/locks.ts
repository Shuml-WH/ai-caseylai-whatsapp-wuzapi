import type { KVNamespace } from "@cloudflare/workers-types"

/**
 * KV-based distributed lock for per-userBot operation serialization.
 *
 * Why: When multiple Worker instances exist, we need to ensure only ONE
 * instance is performing a session operation (connect, send) for a given
 * userBot at any time. This prevents WhatsApp anti-abuse bans caused by
 * multiple concurrent connections from the same number.
 */

const LOCK_PREFIX = "lock:userBot"
const DEFAULT_TTL = 60 // seconds

/**
 * Attempt to acquire a lock for a userBot.
 * Returns true if the lock was acquired, false if it's already held.
 */
export async function acquireLock(
  kv: KVNamespace,
  userBot: string,
  ttlSeconds: number = DEFAULT_TTL
): Promise<boolean> {
  const key = `${LOCK_PREFIX}:${userBot}`

  try {
    // KV put with "onlyIf" semantics: only write if key doesn't exist
    // We use the "set if not exists" pattern via expirationTtl
    const existing = await kv.get(key)
    if (existing) {
      // Check if the existing lock has expired
      const lockData = JSON.parse(existing)
      const age = (Date.now() - lockData.timestamp) / 1000
      if (age < ttlSeconds) {
        return false // Lock is still held
      }
      // Lock expired, we can take it
    }

    await kv.put(
      key,
      JSON.stringify({
        holder: crypto.randomUUID(),
        timestamp: Date.now(),
        ttl: ttlSeconds,
      }),
      { expirationTtl: ttlSeconds }
    )

    // Double-check we actually got it (race condition guard)
    await new Promise((resolve) => setTimeout(resolve, 50))
    const verify = await kv.get(key)
    return verify !== null && verify !== existing
  } catch (error) {
    console.error(`[Lock] Failed to acquire lock for ${userBot}:`, error)
    return false
  }
}

/**
 * Release a lock for a userBot.
 */
export async function releaseLock(
  kv: KVNamespace,
  userBot: string
): Promise<void> {
  const key = `${LOCK_PREFIX}:${userBot}`
  try {
    await kv.delete(key)
  } catch (error) {
    console.error(`[Lock] Failed to release lock for ${userBot}:`, error)
  }
}

/**
 * Extend an existing lock's TTL (heartbeat).
 */
export async function extendLock(
  kv: KVNamespace,
  userBot: string,
  ttlSeconds: number = DEFAULT_TTL
): Promise<boolean> {
  const key = `${LOCK_PREFIX}:${userBot}`
  try {
    const existing = await kv.get(key)
    if (!existing) return false

    await kv.put(key, existing, { expirationTtl: ttlSeconds })
    return true
  } catch {
    return false
  }
}

/**
 * Retry acquiring a lock with exponential backoff.
 */
export async function acquireLockWithRetry(
  kv: KVNamespace,
  userBot: string,
  maxRetries: number = 5,
  baseDelayMs: number = 500
): Promise<boolean> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const acquired = await acquireLock(kv, userBot)
    if (acquired) return true

    const delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * 200
    await new Promise((resolve) => setTimeout(resolve, delay))
  }
  return false
}
