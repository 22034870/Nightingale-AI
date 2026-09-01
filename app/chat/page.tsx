import ChatClient from "./ChatClient";
import { resolveOpening, isSensitiveTopic } from "@/lib/channels/rules";
import { getClinic } from "@/lib/grounding/corpus";

/**
 * The guest chat surface.
 *
 * The opening is resolved SERVER-SIDE from config/channel_rules.yaml, so
 * arriving from an Instagram ad and arriving from a staff referral genuinely
 * produce different first messages — the brief's observable minimum — rather
 * than the client picking a string.
 *
 * Try it:
 *   /chat?channel=staff_referral&note=asked%20about%20egg%20freezing
 *   /chat?channel=instagram_ad_click&campaign=ivf_over40
 *   /chat?channel=website_widget&topic=cardiac%20screening
 */
export default async function ChatPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const one = (k: string) => {
    const v = params[k];
    return Array.isArray(v) ? v[0] : v;
  };

  const clinic = getClinic();
  const channel = one("channel") ?? "website_widget";
  const topic = one("note") ?? one("topic") ?? one("campaign");

  let opening: string;
  try {
    opening = resolveOpening(channel, {
      clinic_name: clinic.name,
      staff_name: one("staff") ?? "A member of the team",
      topic,
      page_topic: one("topic") ?? "our services",
      campaign: one("campaign"),
      sensitiveTopic: isSensitiveTopic(topic),
    }).opening;
  } catch {
    // An unknown channel must not break the surface — fall back to the
    // anonymous default rather than showing an error to a worried stranger.
    opening = resolveOpening("website_widget", {
      clinic_name: clinic.name,
      page_topic: "our services",
    }).opening;
  }

  return <ChatClient opening={opening} />;
}
