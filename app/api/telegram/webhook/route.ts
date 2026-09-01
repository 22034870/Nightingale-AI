import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import {
  sendMessage,
  sendTyping,
  answerCallback,
  getSession,
  saveSession,
  clearSession,
  escapeHtml,
  type TelegramUpdate,
  type TelegramSession,
} from "@/lib/channels/telegram";
import { respondToTurn, escalationPayload, QuarantineRequired } from "@/lib/chat/respond";
import { resolveOpening } from "@/lib/channels/rules";
import { getClinic } from "@/lib/grounding/corpus";
import { logEvent } from "@/lib/funnel/events";
import { loadChannelRules, timeOfDay } from "@/lib/channels/rules";

const CLINIC_ID = "00000000-0000-0000-0000-000000000001";

/**
 * Telegram webhook.
 *
 * Telegram retries any update it does not get a 200 for, so this ALWAYS returns
 * 200 — a failure here must not turn into the same message being delivered five
 * times to a worried person. Errors are handled inside and surfaced to the user
 * honestly instead.
 *
 * The safety path is identical to the web chat: same respondToTurn, same
 * redaction, same risk gate, same guard. The channel changes how the
 * conversation opens and how the handoff is presented. It changes nothing about
 * what is safe to say — which is the property the whole channel-rules design
 * exists to guarantee.
 */
export async function POST(request: Request) {
  // Telegram signs every request with the secret registered at setWebhook.
  // Without this check the endpoint is a public, unauthenticated way to drive
  // the bot on someone else's behalf.
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret && request.headers.get("x-telegram-bot-api-secret-token") !== secret) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  let update: TelegramUpdate;
  try {
    update = await request.json();
  } catch {
    return NextResponse.json({ ok: true });
  }

  try {
    if (update.callback_query) await handleCallback(update);
    else if (update.message?.text) await handleMessage(update);
  } catch (err) {
    console.error("[telegram]", err instanceof Error ? err.message : err);
    const chatId = update.message?.chat.id ?? update.callback_query?.message?.chat.id;
    if (chatId) {
      await sendMessage(
        chatId,
        "Something went wrong on my side and I haven't sent anything anywhere. " +
          "Please try again.\n\n<i>If this is an emergency, dial 999.</i>",
      ).catch(() => {});
    }
  }

  // Always 200. See above.
  return NextResponse.json({ ok: true });
}

function newSession(chatId: number, handle?: string): TelegramSession {
  return {
    chatId,
    leadSessionId: randomUUID(),
    handle,
    history: [],
    memoryItems: [],
    historyFilled: {},
    askedCount: 0,
    escalated: false,
    lastSeen: Date.now(),
  };
}

async function handleMessage(update: TelegramUpdate) {
  const msg = update.message!;
  const chatId = msg.chat.id;
  const text = msg.text!.trim();
  const handle = msg.from?.username;
  const clinic = getClinic();

  // ---- /start ------------------------------------------------------------
  // The moment the platform itself guarantees: nothing can be sent before this.
  if (text === "/start" || text.startsWith("/start ")) {
    const session = newSession(chatId, handle);
    saveSession(session);

    const opening = resolveOpening("telegram_bot", { clinic_name: clinic.name });

    await logEvent({
      clinicId: CLINIC_ID,
      leadSessionId: session.leadSessionId,
      eventType: "visitor",
      metadata: {
        source_channel: "telegram_bot",
        identity_level: "handle_only",
        time_of_day: opening.timeOfDay,
      },
    });

    await sendMessage(
      chatId,
      `${escapeHtml(opening.opening)}\n\n` +
        `<i>I'm software, not a doctor. I can't diagnose you. Anything that ` +
        `needs clinical judgement goes to a real nurse.</i>\n\n` +
        `<b>If this is an emergency, stop and dial 999.</b>`,
    );
    return;
  }

  if (text === "/reset") {
    clearSession(chatId);
    await sendMessage(chatId, "Cleared. Send /start to begin again.");
    return;
  }

  if (text === "/help") {
    await sendMessage(
      chatId,
      "Ask me anything about the clinic — services, hours, prices, how to prepare " +
        "for an appointment.\n\nIf you describe a symptom I'll ask the questions a " +
        "clinician would ask, so you don't have to explain it twice when you get " +
        "there.\n\n/reset to start over\n\n<b>Emergency? Dial 999.</b>",
    );
    return;
  }

  // ---- A real message ----------------------------------------------------
  let session = getSession(chatId);
  if (!session) {
    // Cold start or expiry. Say so rather than silently starting over — the
    // person may have already told us things we no longer have.
    session = newSession(chatId, handle);
    saveSession(session);
    await sendMessage(
      chatId,
      "<i>I've lost the thread of our earlier conversation, so I may ask " +
        "something you've already answered. Sorry about that.</i>",
    );
  }

  await sendTyping(chatId);

  let turn;
  try {
    turn = await respondToTurn(text, {
      history: session.history.slice(-6),
      memoryItems: session.memoryItems,
      historyFilled: session.historyFilled,
      complaintType: session.complaintType,
      askedCount: session.askedCount,
    });
  } catch (err) {
    if (err instanceof QuarantineRequired) {
      // Fail closed, and say so. The message never reached a model.
      await sendMessage(
        chatId,
        "I couldn't process that safely, so I haven't sent it anywhere. " +
          "Could you try sending it again?",
      );
      return;
    }
    throw err;
  }

  session.history.push(text, turn.reply);
  session.memoryItems = turn.memoryItems;
  session.historyFilled = turn.history.filled;
  session.complaintType = turn.history.complaintType;
  session.askedCount = turn.history.nextQuestion ? session.askedCount + 1 : session.askedCount;
  saveSession(session);

  if (session.history.length === 2) {
    await logEvent({
      clinicId: CLINIC_ID,
      leadSessionId: session.leadSessionId,
      eventType: "conversation_started",
      metadata: { source_channel: "telegram_bot" },
    });
  }
  for (const ve of turn.valueEvents) {
    await logEvent({
      clinicId: CLINIC_ID,
      leadSessionId: session.leadSessionId,
      eventType: "value_event",
      valueEventId: ve,
      metadata: { source_channel: "telegram_bot" },
    });
  }

  let body = escapeHtml(turn.reply);

  // The completeness meter, in the only form a chat channel allows. Same
  // honest-numbers rule: it counts answered fields against a fixed denominator.
  if (turn.history.progress.done > 0 && !turn.history.haltedReason) {
    body +=
      `\n\n<i>${turn.history.progress.done} of ${turn.history.progress.total} ` +
      `ready for the clinician.</i>`;
  }

  // High risk surfaces the emergency line inline, since a chat channel has no
  // persistent banner below the composer.
  if (turn.showEmergencyBanner) {
    body += `\n\n<b>${escapeHtml(turn.emergencyBannerText)}</b>`;
  }

  await sendMessage(chatId, body, {
    escalateButton: turn.escalationRequired && !session.escalated,
  });
}

async function handleCallback(update: TelegramUpdate) {
  const cb = update.callback_query!;
  const chatId = cb.message?.chat.id;
  if (!chatId || cb.data !== "escalate") {
    await answerCallback(cb.id);
    return;
  }

  const session = getSession(chatId);
  if (!session) {
    await answerCallback(cb.id, "That conversation has expired.");
    await sendMessage(chatId, "Send /start to begin again.");
    return;
  }

  await answerCallback(cb.id, "Sending…");
  await sendTyping(chatId);

  const lastUser = session.history[session.history.length - 2] ?? "";
  const turn = await respondToTurn(lastUser, {
    history: session.history.slice(-6),
    memoryItems: session.memoryItems,
    historyFilled: session.historyFilled,
    complaintType: session.complaintType,
  });
  const payload = escalationPayload(turn);

  const rules = loadChannelRules();
  const expectation = rules.response_expectation[timeOfDay()];

  await logEvent({
    clinicId: CLINIC_ID,
    leadSessionId: session.leadSessionId,
    eventType: "escalation_sent",
    metadata: {
      source_channel: "telegram_bot",
      risk_level: turn.riskLevel,
      deciding_layer: turn.decidingLayer,
      matched_rule_id: turn.matchedRuleId,
      history_completeness: turn.history.completenessPct,
      top_concern: turn.profile.chief_complaint,
    },
  });

  session.escalated = true;
  saveSession(session);

  const summaryLines = payload.history_snapshot.fields
    .filter((f) => f.answered)
    .map((f) => `• ${escapeHtml(f.label)}: ${escapeHtml(String(f.value))}`)
    .join("\n");

  await sendMessage(
    chatId,
    `<b>Sent to the clinical team.</b>\n\n` +
      `Here's what went with it:\n${summaryLines || "• Your message"}\n\n` +
      // Computed from clinic hours, not a fixed promise. C&D §3.3 #8.
      `${escapeHtml(expectation.text)} ` +
      `${escapeHtml(rules.response_expectation.always_append.trim())}\n\n` +
      `<i>You can keep talking to me in the meantime.</i>`,
  );
}

/** Health check — confirms the route is reachable without exposing the token. */
export async function GET() {
  return NextResponse.json({
    ok: true,
    configured: Boolean(process.env.TELEGRAM_BOT_TOKEN),
    secret_required: Boolean(process.env.TELEGRAM_WEBHOOK_SECRET),
  });
}
