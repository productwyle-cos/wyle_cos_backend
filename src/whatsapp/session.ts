// src/whatsapp/session.ts
// Manages the Baileys WhatsApp Web session.
// Generates QR codes, handles reconnection, and forwards messages to the classifier.

import makeWASocket, {
  DisconnectReason,
  isJidBroadcast,
  isJidGroup,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  proto,
  AuthenticationState,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import QRCode from 'qrcode';
import pino from 'pino';
import { store } from './store';
import { classifyMessage } from '../services/classifier';
import { WhatsAppMessage } from '../types';
import { useRedisAuthState, useFilesystemAuthState, isRedisConfigured } from './redisAuthState';

const logger = pino({ level: 'silent' });

let sock: ReturnType<typeof makeWASocket> | null = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;

// ── Persist auth state IN MEMORY across reconnects (fixes race condition) ──────
// Only re-read from Redis/filesystem on cold start (authState === null).
// After 515 reconnects, we reuse the same state object (already updated in-memory).
let authState: AuthenticationState | null = null;
let authSaveCreds: (() => Promise<void>) | null = null;
let authClearState: (() => Promise<void>) | null = null;

// ── Extract phone number from JID ─────────────────────────────────────────────
function jidToPhone(jid: string): string {
  return jid.replace(/[@:]\S*/g, '').trim();
}

// ── Extract display name from message ────────────────────────────────────────
function getSenderName(msg: proto.IWebMessageInfo): string {
  const sockAny = sock as any;
  const contactsName = sockAny?.contacts?.[msg.key.participant ?? msg.key.remoteJid ?? '']?.name;
  return (
    msg.pushName ??
    contactsName ??
    jidToPhone(msg.key.participant ?? msg.key.remoteJid ?? '')
  );
}

// ── Extract text content from any message type ────────────────────────────────
function extractText(msg: proto.IWebMessageInfo): string | null {
  const m = msg.message;
  if (!m) return null;
  return (
    m.conversation ??
    m.extendedTextMessage?.text ??
    m.imageMessage?.caption ??
    m.videoMessage?.caption ??
    m.documentMessage?.caption ??
    null
  );
}

// ── Process a single incoming message ────────────────────────────────────────
async function handleMessage(msg: proto.IWebMessageInfo): Promise<void> {
  const msgId = msg.key.id ?? '';

  if (msg.key.fromMe) return;
  if (store.isProcessed(msgId)) return;
  store.markProcessed(msgId);

  const remoteJid = msg.key.remoteJid ?? '';
  if (isJidBroadcast(remoteJid)) return;

  const text = extractText(msg);
  console.log(`[WA] Raw message received — from: ${remoteJid}, text: ${text ? `"${text.slice(0, 80)}"` : 'null'}`);
  if (!text || text.trim().length < 2) return;

  const isGroup = isJidGroup(remoteJid) ?? false;
  const senderJid = (isGroup ? msg.key.participant : remoteJid) ?? remoteJid;
  const senderPhone = jidToPhone(senderJid);
  const senderName = getSenderName(msg);

  const waMessage: WhatsAppMessage = {
    id:          msgId,
    chatId:      remoteJid,
    senderJid,
    senderName,
    senderPhone,
    text:        text.trim(),
    timestamp:   (msg.messageTimestamp as number) ?? Math.floor(Date.now() / 1000),
    isGroup,
    groupName:   isGroup ? ((sock as any).chats?.[remoteJid]?.name ?? remoteJid) : undefined,
  };

  console.log(`[WA] Message from ${senderName}: "${text.slice(0, 60)}"`);

  const obligation = await classifyMessage(waMessage);
  if (obligation) {
    store.addObligation(obligation);
    console.log(`[WA] ✅ Obligation created: ${obligation.title}`);
  }
}

// ── Create socket with current in-memory auth state ──────────────────────────
async function createSocket(): Promise<void> {
  const { version } = await fetchLatestBaileysVersion();
  console.log(`[WA] Starting Baileys v${version.join('.')}`);

  sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false,
    auth: {
      creds: authState!.creds,
      keys: makeCacheableSignalKeyStore(authState!.keys, logger),
    },
    browser: ['Ubuntu', 'Chrome', '120.0.6099.71'],
    syncFullHistory: false,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
    keepAliveIntervalMs: 15_000,   // ping WhatsApp every 15s to keep connection alive
    connectTimeoutMs: 60_000,      // allow 60s for initial connection
  });

  // QR code event
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('[WA] QR code generated — waiting for scan');
      try {
        const qrDataUrl = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
        store.setQR(qrDataUrl);
      } catch (e) {
        console.error('[WA] QR generation failed:', e);
      }
    }

    if (connection === 'open') {
      reconnectAttempts = 0;
      const phone = jidToPhone(sock!.user?.id ?? '');
      const name  = sock!.user?.name ?? '';
      console.log(`[WA] ✅ Connected as ${name} (${phone})`);
      store.setConnected(phone, name);
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      const errMsg = (lastDisconnect?.error as any)?.message ?? 'no message';
      console.log(`[WA] Disconnected (code: ${statusCode}, reconnect: ${shouldReconnect}, error: ${errMsg})`);
      store.setDisconnected();

      if (shouldReconnect && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        reconnectAttempts++;
        // After QR scan (515 = restart required by WA), reconnect fast using same in-memory state
        const delay = statusCode === 515 ? 500 : Math.min(3000 * reconnectAttempts, 30000);
        console.log(`[WA] Reconnecting in ${delay}ms (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
        setTimeout(createSocket, delay); // ← reuse existing authState, don't re-read Redis
      } else if (statusCode === DisconnectReason.loggedOut) {
        console.log('[WA] Logged out — clearing auth and restarting fresh');
        authState = null; // Force re-read from Redis/filesystem on next connect
        if (authClearState) await authClearState();
        setTimeout(connectWhatsApp, 3000);
      } else if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        console.log('[WA] Max reconnects reached — resetting auth state');
        authState = null; // Force fresh read
        reconnectAttempts = 0;
        setTimeout(connectWhatsApp, 5000);
      }
    }
  });

  // Save credentials — updates in-memory state AND persists to Redis/filesystem
  sock.ev.on('creds.update', async () => {
    if (authSaveCreds) {
      await authSaveCreds();
      console.log('[WA] Credentials updated and saved');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    console.log(`[WA] messages.upsert fired — type: ${type}, count: ${messages.length}`);
    if (type !== 'notify') {
      console.log(`[WA] Skipping non-notify type: ${type}`);
      return;
    }
    for (const msg of messages) {
      await handleMessage(msg).catch(err => {
        console.error('[WA] Error handling message:', err);
      });
    }
  });
}

// ── Connect — loads auth state fresh from storage, then creates socket ────────
export async function connectWhatsApp(): Promise<void> {
  const useRedis = isRedisConfigured();
  console.log(`[WA] Auth storage: ${useRedis ? 'Upstash Redis ✅' : 'Filesystem (ephemeral)'}`);

  // Load auth state from storage (only on cold start or after logout)
  const auth = useRedis
    ? await useRedisAuthState()
    : await useFilesystemAuthState();

  authState      = auth.state;
  authSaveCreds  = auth.saveCreds;
  authClearState = auth.clearState;

  await createSocket();
}

// ── Send a message ────────────────────────────────────────────────────────────
export async function sendWhatsAppMessage(chatId: string, text: string): Promise<boolean> {
  if (!sock) { console.error('[WA] Cannot send — not connected'); return false; }
  try {
    await sock.sendMessage(chatId, { text });
    console.log(`[WA] ✅ Message sent to ${chatId}`);
    return true;
  } catch (err) {
    console.error('[WA] Send failed:', err);
    return false;
  }
}

// ── Disconnect cleanly ────────────────────────────────────────────────────────
export async function disconnectWhatsApp(): Promise<void> {
  if (!sock) return;
  try { await sock.logout(); } catch {}
  sock = null;
  authState = null;
  store.setDisconnected();
  if (authClearState) await authClearState();
  console.log('[WA] Disconnected and auth cleared');
}
