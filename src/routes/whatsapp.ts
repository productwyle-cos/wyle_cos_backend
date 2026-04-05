// src/routes/whatsapp.ts
// REST API routes exposed to the Wyle mobile app.

import { Router, Request, Response } from 'express';
import { store } from '../whatsapp/store';
import { sendWhatsAppMessage, disconnectWhatsApp, connectWhatsApp } from '../whatsapp/session';
import { redisFlushAll } from '../whatsapp/redisAuthState';

const router = Router();

// ── Auth middleware ────────────────────────────────────────────────────────────
function requireAuth(req: Request, res: Response, next: () => void) {
  const secret = process.env.API_SECRET;
  if (!secret) return next(); // No secret configured — open in dev
  const provided = req.headers['x-api-secret'] ?? req.query.secret;
  if (provided !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

router.use(requireAuth);

// ── GET /whatsapp/status ───────────────────────────────────────────────────────
// Returns connection status and phone number
router.get('/status', (_req: Request, res: Response) => {
  res.json(store.getStatus());
});

// ── GET /whatsapp/qr ──────────────────────────────────────────────────────────
// Returns the QR code as a base64 data URL for display in the app
router.get('/qr', (_req: Request, res: Response) => {
  const status = store.getStatus();
  if (status.connected) {
    return res.json({ connected: true, message: 'Already connected — no QR needed' });
  }
  const qr = store.getQR();
  if (!qr) {
    return res.status(202).json({ waiting: true, message: 'QR not ready yet — retry in 2s' });
  }
  res.json({ qr, instructions: 'Open WhatsApp → Linked Devices → Link a Device → Scan this QR' });
});

// ── GET /whatsapp/obligations ─────────────────────────────────────────────────
// Returns all pending obligations detected from WhatsApp messages
router.get('/obligations', (_req: Request, res: Response) => {
  const obligations = store.getPendingObligations();
  res.json({ count: obligations.length, obligations });
});

// ── GET /whatsapp/obligations/all ─────────────────────────────────────────────
// Returns all obligations (including dismissed/sent)
router.get('/obligations/all', (_req: Request, res: Response) => {
  const obligations = store.getAllObligations();
  res.json({ count: obligations.length, obligations });
});

// ── POST /whatsapp/reply/approve ──────────────────────────────────────────────
// User approves a suggested reply — sends it via WhatsApp
// Body: { obligationId: string, replyText: string }
router.post('/reply/approve', async (req: Request, res: Response) => {
  const { obligationId, replyText } = req.body as { obligationId?: string; replyText?: string };

  if (!obligationId || !replyText) {
    return res.status(400).json({ error: 'obligationId and replyText are required' });
  }

  const obligation = store.approveReply(obligationId);
  if (!obligation) {
    return res.status(404).json({ error: 'Obligation not found' });
  }

  const sent = await sendWhatsAppMessage(obligation.chatId, replyText);
  if (!sent) {
    return res.status(500).json({ error: 'Failed to send message — WhatsApp may be disconnected' });
  }

  store.updateObligationStatus(obligationId, 'sent');
  res.json({ success: true, message: `Reply sent to ${obligation.senderName}` });
});

// ── POST /whatsapp/obligations/:id/dismiss ────────────────────────────────────
// User dismisses an obligation (marks as not needed)
router.post('/obligations/:id/dismiss', (req: Request, res: Response) => {
  const updated = store.updateObligationStatus(req.params.id, 'dismissed');
  if (!updated) return res.status(404).json({ error: 'Obligation not found' });
  res.json({ success: true });
});

// ── POST /whatsapp/send ───────────────────────────────────────────────────────
// Send a custom message (not reply — e.g. vendor order)
// Body: { chatId: string, text: string }
router.post('/send', async (req: Request, res: Response) => {
  const { chatId, text } = req.body as { chatId?: string; text?: string };
  if (!chatId || !text) {
    return res.status(400).json({ error: 'chatId and text are required' });
  }
  const sent = await sendWhatsAppMessage(chatId, text);
  if (!sent) {
    return res.status(500).json({ error: 'Failed to send — WhatsApp may be disconnected' });
  }
  res.json({ success: true });
});

// ── DELETE /whatsapp/disconnect ───────────────────────────────────────────────
// Logs out and clears the WhatsApp session
router.delete('/disconnect', async (_req: Request, res: Response) => {
  await disconnectWhatsApp();
  res.json({ success: true, message: 'WhatsApp session cleared — re-scan QR to reconnect' });
});

// ── POST /whatsapp/reset ──────────────────────────────────────────────────────
// Nuclear reset: flush ALL Redis keys (including corrupted signal keys), then
// restart the session so a fresh QR is generated immediately.
// Use this when you see "Cannot read properties of undefined (reading 'public')"
// or any other crypto / signal key corruption error.
router.post('/reset', async (_req: Request, res: Response) => {
  console.log('[WA] /reset called — flushing Redis and restarting session');
  try {
    await disconnectWhatsApp();         // close socket, clear in-memory state
    await redisFlushAll();              // wipe ALL Redis keys (signal keys included)
    setTimeout(() => {
      connectWhatsApp().catch(err => {
        console.error('[WA] Reconnect after reset failed:', err);
      });
    }, 1000);
    res.json({ success: true, message: 'Redis flushed — new QR generating in ~3s. Poll /whatsapp/qr' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message ?? String(err) });
  }
});

// ── POST /whatsapp/debug/classify ─────────────────────────────────────────────
// Test the classifier directly with a fake message — no WhatsApp needed
// Body: { text: string, senderName?: string }
router.post('/debug/classify', async (req: Request, res: Response) => {
  const { text, senderName = 'Test Sender' } = req.body as { text?: string; senderName?: string };
  if (!text) return res.status(400).json({ error: 'text is required' });

  const { classifyMessage } = await import('../services/classifier');
  const fakeMsg = {
    id:          `debug_${Date.now()}`,
    chatId:      '1234567890@s.whatsapp.net',
    senderJid:   '1234567890@s.whatsapp.net',
    senderName,
    senderPhone: '1234567890',
    text,
    timestamp:   Math.floor(Date.now() / 1000),
    isGroup:     false,
  };

  const obligation = await classifyMessage(fakeMsg);
  if (obligation) {
    store.addObligation(obligation);
    return res.json({ detected: true, obligation });
  }
  res.json({ detected: false, message: 'Message classified as not actionable' });
});

export default router;
