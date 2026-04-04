// src/services/classifier.ts
// Classifies WhatsApp messages and extracts obligations.
// Uses rule-based detection first; Claude AI when API key is available.

import { WhatsAppMessage, WhatsAppObligation, ObligationType, ObligationRisk } from '../types';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? '';

// ── Informational message filter ──────────────────────────────────────────────
// Returns true if the message needs NO action from the user
function isInformational(text: string): boolean {
  const t = text.toLowerCase();
  return (
    /^(ok|okay|thanks|thank you|noted|got it|sure|np|no problem|sounds good|great|perfect|👍|✅|🙏)\.?$/i.test(t.trim()) ||
    /has been (delivered|dispatched|processed|confirmed|received)/i.test(t) ||
    /your order (has|is)/i.test(t) ||
    /payment (received|confirmed|processed|successful)/i.test(t) ||
    /thank you for (your|the)/i.test(t) ||
    /good morning|good evening|good night|good afternoon/i.test(t) && t.length < 40 ||
    /^(hi|hello|hey|hii|heyy)\.?!?$/i.test(t.trim())
  );
}

// ── Action keyword detector ───────────────────────────────────────────────────
function detectType(text: string): { type: ObligationType; emoji: string } | null {
  const t = text.toLowerCase();

  if (/\b(meet|meeting|call|zoom|teams|google meet|schedule|catch up|sync|discuss|agenda)\b/i.test(t) &&
      /\b(tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d+[ap]m|next week|this week|\d{1,2}(st|nd|rd|th)?)\b/i.test(t)) {
    return { type: 'appointment', emoji: '📅' };
  }

  if (/\b(please reply|let me know|can you|could you|would you|thoughts|feedback|opinion|respond|revert|get back|your input|waiting for|when can|are you available)\b/i.test(t)) {
    return { type: 'reply_needed', emoji: '📧' };
  }

  if (/\b(invoice|payment|amount due|aed|pay|transfer|bank|outstanding|balance|bill|fee|charges)\b/i.test(t)) {
    return { type: 'payment', emoji: '💰' };
  }

  if (/\b(sign|signature|agreement|contract|document|approve|authorization|consent)\b/i.test(t)) {
    return { type: 'sign_document', emoji: '📄' };
  }

  if (/\b(order|deliver|send|arrange|book|reserve|confirm|vendor|supplier|service)\b/i.test(t)) {
    return { type: 'vendor_followup', emoji: '📦' };
  }

  if (/\b(urgent|asap|immediately|right away|priority|critical|deadline|by tomorrow|by today|by end of day|by eod|by cob)\b/i.test(t)) {
    return { type: 'task', emoji: '⚡' };
  }

  return null;
}

// ── Meeting time extractor ────────────────────────────────────────────────────
function extractMeetingTime(text: string): string | undefined {
  const now = new Date();

  if (/tomorrow/i.test(text)) {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    // Try to extract time
    const timeMatch = text.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
    if (timeMatch) {
      let hour = parseInt(timeMatch[1]);
      const min = parseInt(timeMatch[2] ?? '0');
      if (timeMatch[3].toLowerCase() === 'pm' && hour < 12) hour += 12;
      d.setHours(hour, min, 0, 0);
    } else {
      d.setHours(10, 0, 0, 0); // default 10am
    }
    return d.toISOString();
  }

  const dayMatch = text.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
  if (dayMatch) {
    const days = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
    const target = days.indexOf(dayMatch[1].toLowerCase());
    const d = new Date(now);
    let diff = target - d.getDay();
    if (diff <= 0) diff += 7;
    d.setDate(d.getDate() + diff);

    const timeMatch = text.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
    if (timeMatch) {
      let hour = parseInt(timeMatch[1]);
      const min = parseInt(timeMatch[2] ?? '0');
      if (timeMatch[3].toLowerCase() === 'pm' && hour < 12) hour += 12;
      d.setHours(hour, min, 0, 0);
    } else {
      d.setHours(10, 0, 0, 0);
    }
    return d.toISOString();
  }

  return undefined;
}

// ── Risk calculator ───────────────────────────────────────────────────────────
function calcRisk(text: string, type: ObligationType): { risk: ObligationRisk; daysUntil: number } {
  const t = text.toLowerCase();
  if (/urgent|asap|immediately|right away|today|by eod|by cob/i.test(t)) {
    return { risk: 'high', daysUntil: 0 };
  }
  if (/tomorrow/i.test(t)) return { risk: 'high', daysUntil: 1 };
  if (/this week|next 2 days|48 hours/i.test(t)) return { risk: 'high', daysUntil: 3 };
  if (/next week|within a week/i.test(t)) return { risk: 'medium', daysUntil: 7 };

  // Defaults by type
  switch (type) {
    case 'appointment':     return { risk: 'high',   daysUntil: 1 };
    case 'reply_needed':    return { risk: 'high',   daysUntil: 2 };
    case 'payment':         return { risk: 'medium',  daysUntil: 5 };
    case 'sign_document':   return { risk: 'medium',  daysUntil: 3 };
    case 'vendor_followup': return { risk: 'medium',  daysUntil: 2 };
    default:                return { risk: 'low',    daysUntil: 7 };
  }
}

// ── Title builder ─────────────────────────────────────────────────────────────
function buildTitle(type: ObligationType, text: string, senderName: string): string {
  const preview = text.replace(/\s+/g, ' ').trim().slice(0, 60);
  switch (type) {
    case 'appointment':     return `Meeting request from ${senderName}`;
    case 'reply_needed':    return `Reply needed — ${senderName}`;
    case 'payment':         return `Payment request from ${senderName}`;
    case 'sign_document':   return `Document to sign — ${senderName}`;
    case 'vendor_followup': return `Vendor action — ${senderName}`;
    case 'task':            return preview.length > 10 ? preview : `Task from ${senderName}`;
    default:                return `Message from ${senderName}`;
  }
}

// ── Claude AI classifier (enhanced) ──────────────────────────────────────────
async function classifyWithClaude(msg: WhatsAppMessage): Promise<Partial<WhatsAppObligation> | null> {
  if (!ANTHROPIC_API_KEY) return null;

  const prompt = `You are analyzing a WhatsApp message for a Dubai professional's AI chief of staff app.

Message from: ${msg.senderName} (${msg.senderPhone})
${msg.isGroup ? `Group: ${msg.groupName}` : 'Direct message'}
Text: "${msg.text}"

Determine if this message requires any action from the recipient.

Return a JSON object with:
{
  "isActionable": boolean,
  "type": "appointment|reply_needed|payment|sign_document|vendor_followup|task|other",
  "title": "concise 5-8 word title for the obligation",
  "risk": "high|medium|low",
  "daysUntil": number (0=today, 1=tomorrow, etc.),
  "suggestedReply": "a brief, professional reply draft in the recipient's voice — or null",
  "meetingTime": "ISO date string if a meeting is proposed — or null",
  "reasoning": "one sentence why this is or isn't actionable"
}

Rules:
- Group messages: only flag if the message explicitly @mentions the user or asks a direct question
- "Ok", "Thanks", "👍" type messages are NOT actionable
- Meeting proposals ARE actionable (appointment type)
- Any "please reply", "let me know", "can you" IS actionable (reply_needed)
- Payment requests, invoices ARE actionable (payment)`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!res.ok) return null;
    const data = await res.json() as any;
    const raw = data.content?.[0]?.text ?? '{}';
    const clean = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    if (!parsed.isActionable) return null;
    return {
      type:          parsed.type ?? 'other',
      title:         parsed.title,
      risk:          parsed.risk ?? 'medium',
      daysUntil:     parsed.daysUntil ?? 2,
      suggestedReply: parsed.suggestedReply ?? undefined,
      meetingTime:   parsed.meetingTime ?? undefined,
    };
  } catch {
    return null;
  }
}

// ── Main classify function ────────────────────────────────────────────────────
export async function classifyMessage(msg: WhatsAppMessage): Promise<WhatsAppObligation | null> {
  // 1. Skip purely informational messages immediately
  if (isInformational(msg.text)) return null;

  // 2. Skip very short messages with no action keywords (< 5 words)
  const wordCount = msg.text.trim().split(/\s+/).length;
  if (wordCount < 3) return null;

  // 3. For group messages, only surface if clearly directed at user
  // (Claude will handle the nuance; rule-based skips all group messages for safety)
  if (msg.isGroup && !ANTHROPIC_API_KEY) return null;

  // 4. Try Claude first for best results
  const claudeResult = await classifyWithClaude(msg);
  if (claudeResult && claudeResult.type) {
    const { risk, daysUntil } = calcRisk(msg.text, claudeResult.type as ObligationType);
    return {
      id:              `wa_${msg.id}_${Date.now()}`,
      source:          'whatsapp',
      type:            (claudeResult.type as ObligationType) ?? 'other',
      title:           claudeResult.title ?? buildTitle(claudeResult.type as ObligationType, msg.text, msg.senderName),
      risk:            claudeResult.risk ?? risk,
      daysUntil:       claudeResult.daysUntil ?? daysUntil,
      status:          'pending',
      createdAt:       new Date().toISOString(),
      senderJid:       msg.senderJid,
      senderName:      msg.senderName,
      senderPhone:     msg.senderPhone,
      originalMessage: msg.text,
      chatId:          msg.chatId,
      suggestedReply:  claudeResult.suggestedReply,
      meetingTime:     claudeResult.meetingTime,
    };
  }

  // 5. Rule-based fallback
  const detected = detectType(msg.text);
  if (!detected) return null;

  const { risk, daysUntil } = calcRisk(msg.text, detected.type);
  const meetingTime = detected.type === 'appointment' ? extractMeetingTime(msg.text) : undefined;

  return {
    id:              `wa_${msg.id}_${Date.now()}`,
    source:          'whatsapp',
    type:            detected.type,
    title:           buildTitle(detected.type, msg.text, msg.senderName),
    risk,
    daysUntil,
    status:          'pending',
    createdAt:       new Date().toISOString(),
    senderJid:       msg.senderJid,
    senderName:      msg.senderName,
    senderPhone:     msg.senderPhone,
    originalMessage: msg.text,
    chatId:          msg.chatId,
    meetingTime,
  };
}
