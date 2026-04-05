// src/whatsapp/session.ts
// Manages the Baileys WhatsApp Web session.
// Generates QR codes, handles reconnection, and forwards messages to the classifier.

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  isJidBroadcast,
  isJidGroup,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  proto,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import QRCode from 'qrcode';
import * as fs from 'fs';
import * as path from 'path';
import pino from 'pino';
import { store } from './store';
import { classifyMessage } from '../services/classifier';
import { WhatsAppMessage } from '../types';

const AUTH_DIR = process.env.AUTH_DIR ?? './auth_sessions';
const logger = pino({ level: 'silent' }); // Baileys internal logger — keep silent in prod

let sock: ReturnType<typeof makeWASocket> | null = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;

// ── Extract phone number from JID ─────────────────────────────────────────────
function jidToPhone(jid: string): string {
  return jid.replace(/[@:]\S*/g, '').trim();
}

// ── Extract display name from message ────────────────────────────────────────
function getSenderName(msg: proto.IWebMessageInfo, sock: ReturnType<typeof makeWASocket>): string {
  // sock.contacts / sock.store are version-dependent — use optional chaining with any cast
  const sockAny = sock as any;
  const contactsName = sockAny.contacts?.[msg.key.participant ?? msg.key.remoteJid ?? '']?.name;
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

  // Skip outgoing messages (sent BY the user), broadcasts, and already-processed
  if (msg.key.fromMe) return;
  if (store.isProcessed(msgId)) return;
  store.markProcessed(msgId);

  const remoteJid = msg.key.remoteJid ?? '';
  if (isJidBroadcast(remoteJid)) return;

  const text = extractText(msg);
  if (!text || text.trim().length < 2) return;

  const isGroup = isJidGroup(remoteJid) ?? false;
  const senderJid = (isGroup ? msg.key.participant : remoteJid) ?? remoteJid;
  const senderPhone = jidToPhone(senderJid);
  const senderName = getSenderName(msg, sock!);

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

  // Classify and create obligation if actionable
  const obligation = await classifyMessage(waMessage);
  if (obligation) {
    store.addObligation(obligation);
    console.log(`[WA] ✅ Obligation created: ${obligation.title}`);
  }
}

// ── Connect / reconnect ───────────────────────────────────────────────────────
export async function connectWhatsApp(): Promise<void> {
  // Ensure auth directory exists
  if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
  }

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  console.log(`[WA] Starting Baileys v${version.join('.')}`);

  sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false, // We handle QR ourselves via the API
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    browser: ['Wyle COS', 'Chrome', '120.0.0'],
    syncFullHistory: false,
    markOnlineOnConnect: false, // Don't show "online" in WA to avoid detection
    generateHighQualityLinkPreview: false,
  });

  // ── QR code event ──────────────────────────────────────────────────────────
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

      console.log(`[WA] Disconnected (code: ${statusCode}, reconnect: ${shouldReconnect})`);
      store.setDisconnected();

      if (shouldReconnect && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        reconnectAttempts++;
        const delay = Math.min(5000 * reconnectAttempts, 30000); // exponential backoff, max 30s
        console.log(`[WA] Reconnecting in ${delay / 1000}s (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
        setTimeout(connectWhatsApp, delay);
      } else if (statusCode === DisconnectReason.loggedOut) {
        console.log('[WA] Logged out — clearing auth state');
        // Clear auth so user can re-scan QR
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        setTimeout(connectWhatsApp, 3000);
      }
    }
  });

  // ── Save credentials when updated ─────────────────────────────────────────
  sock.ev.on('creds.update', saveCreds);

  // ── Incoming messages ──────────────────────────────────────────────────────
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return; // Only process real-time notifications
    for (const msg of messages) {
      await handleMessage(msg).catch(err => {
        console.error('[WA] Error handling message:', err);
      });
    }
  });
}

// ── Send a message (called when user approves a reply) ───────────────────────
export async function sendWhatsAppMessage(chatId: string, text: string): Promise<boolean> {
  if (!sock) {
    console.error('[WA] Cannot send — not connected');
    return false;
  }
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
  await sock.logout();
  sock = null;
  store.setDisconnected();
  // Clear auth state so next connect shows fresh QR
  fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  console.log('[WA] Disconnected and auth cleared');
}
