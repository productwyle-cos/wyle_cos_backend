// src/whatsapp/redisAuthState.ts
// Stores Baileys auth credentials in Upstash Redis so sessions survive Render restarts.
// Falls back to filesystem if Redis env vars are not set.

import { AuthenticationState, initAuthCreds, BufferJSON, proto } from '@whiskeysockets/baileys';
import * as fs from 'fs';

const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const AUTH_DIR    = process.env.AUTH_DIR ?? './auth_sessions';

const KEY_PREFIX = 'wa_auth:';

// ── Upstash REST helpers ───────────────────────────────────────────────────────
async function redisGet(key: string): Promise<string | null> {
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  try {
    const res = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
    });
    const data = await res.json() as { result: string | null };
    return data.result ?? null;
  } catch {
    return null;
  }
}

async function redisSet(key: string, value: string): Promise<void> {
  if (!REDIS_URL || !REDIS_TOKEN) return;
  try {
    await fetch(`${REDIS_URL}/set/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    });
  } catch (e) {
    console.error('[Redis] Set failed:', e);
  }
}

async function redisDel(key: string): Promise<void> {
  if (!REDIS_URL || !REDIS_TOKEN) return;
  try {
    await fetch(`${REDIS_URL}/del/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
    });
  } catch {}
}

// Flush ALL keys in the Redis DB — used to wipe corrupted signal keys completely
export async function redisFlushAll(): Promise<void> {
  if (!REDIS_URL || !REDIS_TOKEN) return;
  try {
    await fetch(`${REDIS_URL}/flushall`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
    });
    console.log('[Redis] FLUSHALL — all auth keys cleared');
  } catch (e) {
    console.error('[Redis] FLUSHALL failed:', e);
  }
}

// Delete all signal session keys (wa_auth:key:session:*) without touching creds.
// Called before each 428 reconnect so stale v0 sessions don't block migration.
export async function redisDeleteSessionKeys(): Promise<void> {
  if (!REDIS_URL || !REDIS_TOKEN) return;
  try {
    // KEYS returns all keys matching the pattern
    const res = await fetch(
      `${REDIS_URL}/keys/${encodeURIComponent(`${KEY_PREFIX}key:session:*`)}`,
      { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } }
    );
    const data = await res.json() as { result: string[] };
    const keys: string[] = data.result ?? [];
    if (keys.length === 0) {
      console.log('[Redis] No session keys to delete');
      return;
    }
    // DEL key1 key2 ... (multi-key delete in one request)
    const delPath = keys.map(k => encodeURIComponent(k)).join('/');
    await fetch(`${REDIS_URL}/del/${delPath}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
    });
    console.log(`[Redis] Deleted ${keys.length} session key(s)`);
  } catch (e) {
    console.error('[Redis] redisDeleteSessionKeys failed:', e);
  }
}

// ── Check if Redis is configured ──────────────────────────────────────────────
export function isRedisConfigured(): boolean {
  return !!(REDIS_URL && REDIS_TOKEN);
}

// ── Redis-backed auth state ───────────────────────────────────────────────────
export async function useRedisAuthState(): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
  clearState: () => Promise<void>;
}> {
  // Load or init creds
  const credsRaw = await redisGet(`${KEY_PREFIX}creds`);
  const creds = credsRaw
    ? JSON.parse(credsRaw, BufferJSON.reviver)
    : initAuthCreds();

  const state: AuthenticationState = {
    creds,
    keys: {
      get: async (type, ids) => {
        const data: Record<string, any> = {};
        await Promise.all(
          ids.map(async (id) => {
            const raw = await redisGet(`${KEY_PREFIX}key:${type}:${id}`);
            if (raw) {
              let value = JSON.parse(raw, BufferJSON.reviver);
              if (type === 'app-state-sync-key') {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            }
          })
        );
        return data;
      },
      set: async (data) => {
        await Promise.all(
          Object.entries(data).flatMap(([type, ids]) =>
            Object.entries(ids as Record<string, any>).map(([id, value]) => {
              const key = `${KEY_PREFIX}key:${type}:${id}`;
              if (value) {
                return redisSet(key, JSON.stringify(value, BufferJSON.replacer));
              } else {
                return redisDel(key);
              }
            })
          )
        );
      },
    },
  };

  const saveCreds = async () => {
    await redisSet(`${KEY_PREFIX}creds`, JSON.stringify(state.creds, BufferJSON.replacer));
    console.log('[Redis] Credentials saved');
  };

  const clearState = async () => {
    // Flush ALL keys so corrupted signal keys don't survive (not just creds)
    await redisFlushAll();
  };

  return { state, saveCreds, clearState };
}

// ── Filesystem fallback (used when Redis not configured) ──────────────────────
export async function useFilesystemAuthState() {
  const { useMultiFileAuthState } = await import('@whiskeysockets/baileys');
  if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
  }
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  return {
    state,
    saveCreds,
    clearState: async () => {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    },
  };
}
