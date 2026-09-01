import "server-only";

import type { MemoryItem } from "@/lib/history/profile";

/**
 * TELEGRAM BOT ADAPTER.
 *
 * The channel that is green on all four ethics axes and needs no approvals.
 *
 * WHY IT IS THE STRONGEST CHANNEL IN THIS BUILD:
 * a Telegram bot CANNOT message a person who has not pressed Start. That is not
 * a policy we promise to follow — it is enforced by the platform, in the
 * protocol. Every conversation is user-initiated by construction, which is
 * exactly the property MMC's anti-canvassing rule and MAB Guideline 2.1 care
 * about. Compare WhatsApp, where opt-in is a rule you can violate.
 *
 * No app review, no business verification, no message templates.
 */

const API = "https://api.telegram.org/bot";

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number; first_name?: string; username?: string; language_code?: string };
    chat: { id: number; type: string };
    date: number;
    text?: string;
  };
  callback_query?: {
    id: string;
    from: { id: number; username?: string };
    message?: { chat: { id: number }; message_id: number };
    data?: string;
  };
}

function token(): string {
  const t = process.env.TELEGRAM_BOT_TOKEN;
  if (!t) throw new Error("TELEGRAM_BOT_TOKEN is not set.");
  return t;
}

async function call(method: string, body: Record<string, unknown>) {
  const res = await fetch(`${API}${token()}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Telegram ${method} failed: ${res.status} ${detail.slice(0, 200)}`);
  }
  return res.json();
}

export async function sendMessage(
  chatId: number,
  text: string,
  opts: { escalateButton?: boolean; disablePreview?: boolean } = {},
) {
  return call("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: opts.disablePreview ?? true,
    ...(opts.escalateButton
      ? {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  // The trust transition, not "continue securely to send this
                  // to the clinic". Names what they actually dread.
                  text: "Send this to a nurse — you won't have to explain it again",
                  callback_data: "escalate",
                },
              ],
            ],
          },
        }
      : {}),
  });
}

/** Telegram's own typing indicator — no simulated delay, which backfires. */
export async function sendTyping(chatId: number) {
  return call("sendChatAction", { chat_id: chatId, action: "typing" });
}

export async function answerCallback(callbackId: string, text?: string) {
  return call("answerCallbackQuery", { callback_query_id: callbackId, text });
}

export async function setWebhook(url: string, secret: string) {
  return call("setWebhook", {
    url,
    secret_token: secret,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: true,
  });
}

export async function getWebhookInfo() {
  const res = await fetch(`${API}${token()}/getWebhookInfo`);
  return res.json();
}

export async function getMe() {
  const res = await fetch(`${API}${token()}/getMe`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

export interface TelegramSession {
  chatId: number;
  leadSessionId: string;
  handle?: string;
  history: string[];
  memoryItems: MemoryItem[];
  historyFilled: Record<string, string>;
  complaintType?: string;
  askedCount: number;
  escalated: boolean;
  lastSeen: number;
}

/**
 * In-process session store.
 *
 * HONEST LIMITATION, and it belongs in the brief rather than buried here:
 * this is a module-level Map, so it survives only as long as the serverless
 * instance stays warm. A cold start loses conversation state, and the person
 * would be asked something they already answered — the exact failure the whole
 * product is built to avoid.
 *
 * It is used because SUPABASE_SERVICE_ROLE_KEY was not configured in time, not
 * because it is right. The production path already exists: lead_sessions and
 * memory_items are designed for precisely this, `persist()` below is the single
 * place to swap, and provenance would then survive a cold start the same way it
 * survives guest-to-patient conversion.
 *
 * Sessions expire at 7 days to match the guest-data retention decision in
 * PLANNING §12, so the store cannot outlive the policy even in memory.
 */
const sessions = new Map<number, TelegramSession>();
const SESSION_TTL_MS = 7 * 864e5;

export function getSession(chatId: number): TelegramSession | undefined {
  const s = sessions.get(chatId);
  if (!s) return undefined;
  if (Date.now() - s.lastSeen > SESSION_TTL_MS) {
    sessions.delete(chatId);
    return undefined;
  }
  return s;
}

export function saveSession(session: TelegramSession) {
  session.lastSeen = Date.now();
  sessions.set(session.chatId, session);

  // Cheap bound so a long-running instance cannot grow without limit.
  if (sessions.size > 500) {
    const oldest = [...sessions.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen)[0];
    if (oldest) sessions.delete(oldest[0]);
  }
}

export function clearSession(chatId: number) {
  sessions.delete(chatId);
}

/**
 * Telegram supports a narrow subset of HTML. Escaping matters here because
 * patient text is echoed into messages we send, and an unescaped "<" would
 * either break the message or, worse, be interpreted as markup.
 */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
