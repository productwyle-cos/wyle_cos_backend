// src/index.ts
// Wyle COS WhatsApp Backend — Express entry point

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import whatsappRouter from './routes/whatsapp';
import { connectWhatsApp } from './whatsapp/session';

const app  = express();
const PORT = parseInt(process.env.PORT ?? '3000', 10);

// ── CORS ───────────────────────────────────────────────────────────────────────
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (mobile apps, curl, Postman)
    if (!origin) return cb(null, true);
    if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
      return cb(null, true);
    }
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
}));

// ── Body parsing ───────────────────────────────────────────────────────────────
app.use(express.json());

// ── Health check ───────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'wyle-cos-backend', ts: new Date().toISOString() });
});

// ── WhatsApp routes ────────────────────────────────────────────────────────────
app.use('/whatsapp', whatsappRouter);

// ── 404 fallback ───────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ── Global error guards — prevent Baileys internal errors from crashing Render ──
// Baileys' sendRetryRequest / sendPeerDataOperation can throw "Connection Closed"
// (code 428) as an unhandled rejection when the WebSocket drops mid-flight.
// Without this handler Node exits, corrupting the Redis session state.
process.on('unhandledRejection', (reason: any) => {
  const msg = reason?.message ?? String(reason);
  // Suppress known non-fatal Baileys internal errors
  if (
    msg.includes('Connection Closed') ||
    msg.includes('Connection Terminated') ||
    msg.includes('Connection Lost') ||
    msg.includes('ECONNRESET') ||
    msg.includes('EPIPE')
  ) {
    console.warn('[Global] Suppressed non-fatal unhandledRejection:', msg);
    return;
  }
  // For anything else, log but still don't crash
  console.error('[Global] Unhandled rejection (non-fatal):', reason);
});

process.on('uncaughtException', (err: Error) => {
  const msg = err?.message ?? String(err);
  if (
    msg.includes('Connection Closed') ||
    msg.includes('Connection Terminated') ||
    msg.includes('ECONNRESET') ||
    msg.includes('EPIPE')
  ) {
    console.warn('[Global] Suppressed non-fatal uncaughtException:', msg);
    return;
  }
  // Fatal — log and exit cleanly so Render restarts us
  console.error('[Global] Fatal uncaughtException:', err);
  process.exit(1);
});

// ── Start ──────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 Wyle COS Backend running on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
  console.log(`   WhatsApp status: http://localhost:${PORT}/whatsapp/status\n`);

  // Kick off WhatsApp session
  connectWhatsApp().catch(err => {
    console.error('[Boot] Failed to start WhatsApp session:', err);
  });

  // ── Self-ping to prevent Render free tier from sleeping ──────────────────
  const SELF_URL = process.env.RENDER_EXTERNAL_URL ?? `http://localhost:${PORT}`;
  setInterval(async () => {
    try {
      await fetch(`${SELF_URL}/health`);
      console.log('[Ping] Keep-alive sent');
    } catch {
      // Ignore ping failures
    }
  }, 10 * 60 * 1000); // every 10 minutes
});
