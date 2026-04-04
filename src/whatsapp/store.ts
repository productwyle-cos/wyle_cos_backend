// src/whatsapp/store.ts
// In-memory store for obligations and session state.
// Acts as the bridge between the Baileys session and the REST API.

import { WhatsAppObligation, SessionStatus } from '../types';

class WhatsAppStore {
  private obligations: Map<string, WhatsAppObligation> = new Map();
  private sessionStatus: SessionStatus = { connected: false, qrAvailable: false };
  private currentQR: string | null = null;
  private processedMessageIds: Set<string> = new Set();

  // ── Session state ──────────────────────────────────────────────────────────
  setConnected(phone: string, name: string) {
    this.sessionStatus = { connected: true, phone, name, qrAvailable: false };
    this.currentQR = null;
  }

  setDisconnected() {
    this.sessionStatus = { connected: false, qrAvailable: false };
  }

  setQR(qr: string) {
    this.currentQR = qr;
    this.sessionStatus = { ...this.sessionStatus, connected: false, qrAvailable: true };
  }

  getStatus(): SessionStatus {
    return { ...this.sessionStatus };
  }

  getQR(): string | null {
    return this.currentQR;
  }

  // ── Obligation management ──────────────────────────────────────────────────
  addObligation(obligation: WhatsAppObligation) {
    this.obligations.set(obligation.id, obligation);
    console.log(`[Store] New obligation: ${obligation.title} (${obligation.type})`);
  }

  getPendingObligations(): WhatsAppObligation[] {
    return Array.from(this.obligations.values())
      .filter(o => o.status === 'pending')
      .sort((a, b) => a.daysUntil - b.daysUntil); // most urgent first
  }

  getAllObligations(): WhatsAppObligation[] {
    return Array.from(this.obligations.values())
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  updateObligationStatus(id: string, status: WhatsAppObligation['status']): boolean {
    const ob = this.obligations.get(id);
    if (!ob) return false;
    this.obligations.set(id, { ...ob, status });
    return true;
  }

  approveReply(id: string): WhatsAppObligation | null {
    const ob = this.obligations.get(id);
    if (!ob) return null;
    this.obligations.set(id, { ...ob, replyApproved: true });
    return this.obligations.get(id)!;
  }

  // ── Dedup ──────────────────────────────────────────────────────────────────
  isProcessed(messageId: string): boolean {
    return this.processedMessageIds.has(messageId);
  }

  markProcessed(messageId: string) {
    this.processedMessageIds.add(messageId);
    // Keep set bounded — drop oldest if > 5000
    if (this.processedMessageIds.size > 5000) {
      const first = this.processedMessageIds.values().next().value;
      if (first) this.processedMessageIds.delete(first);
    }
  }
}

// Singleton
export const store = new WhatsAppStore();
