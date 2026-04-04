// src/types/index.ts
// Shared types for the Wyle COS backend

export type ObligationType =
  | 'appointment'
  | 'reply_needed'
  | 'payment'
  | 'sign_document'
  | 'task'
  | 'vendor_followup'
  | 'other';

export type ObligationRisk = 'high' | 'medium' | 'low';

export type ObligationStatus = 'pending' | 'approved' | 'sent' | 'dismissed';

export interface WhatsAppObligation {
  id: string;
  source: 'whatsapp';
  type: ObligationType;
  title: string;
  risk: ObligationRisk;
  daysUntil: number;
  status: ObligationStatus;
  createdAt: string;

  // WhatsApp specific
  senderJid: string;          // WhatsApp JID (phone@s.whatsapp.net)
  senderName: string;
  senderPhone: string;
  originalMessage: string;    // The raw message text
  chatId: string;

  // Reply handling
  suggestedReply?: string;    // AI-drafted reply for the user to approve
  replyApproved?: boolean;

  // Meeting detection
  meetingTime?: string;       // ISO date string if a meeting was proposed
  meetingLocation?: string;
}

export interface WhatsAppMessage {
  id: string;
  chatId: string;
  senderJid: string;
  senderName: string;
  senderPhone: string;
  text: string;
  timestamp: number;
  isGroup: boolean;
  groupName?: string;
}

export interface SessionStatus {
  connected: boolean;
  phone?: string;
  name?: string;
  qrAvailable: boolean;
}
