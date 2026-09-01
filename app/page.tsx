import Link from "next/link";
import { loadRedFlags, loadCopyRules } from "@/lib/config";
import { getClinic, getChunks } from "@/lib/grounding/corpus";
import { loadChecklists } from "@/lib/history/engine";

/**
 * Entry point for a reviewer.
 *
 * Not a marketing page — a set of doors into the things worth looking at, plus
 * the live counts from the safety configuration so the page doubles as a
 * deployment health check. Every number here is read from the config the
 * running system uses, which is the same rule the product applies to itself.
 */
export default function Home() {
  const clinic = getClinic();
  const flags = loadRedFlags();
  const copy = loadCopyRules();
  const checklists = loadChecklists();

  const variants = flags.red_flags.reduce((n, r) => n + r.variants.length, 0);
  const banned = Object.values(copy.banned).reduce((n, b) => n + b.patterns.length, 0);
  const fields = Object.values(checklists.complaint_types).reduce(
    (n, t) => n + t.fields.length,
    0,
  );

  const scenarios = [
    {
      title: "Staff referral",
      note: "Opens already knowing what was discussed. Nothing is re-asked.",
      href: "/chat?channel=staff_referral&staff=Dr%20Lim&note=asked%20about%20egg%20freezing%20at%20today's%20visit",
    },
    {
      title: "Instagram ad",
      note: "Same page, campaign-aware opening. Channel changes tone, never safety.",
      href: "/chat?channel=instagram_ad_click&campaign=ivf_over40",
    },
    {
      title: "Website widget",
      note: "Anonymous, page-topic aware.",
      href: "/chat?channel=website_widget&topic=cardiac%20screening",
    },
  ];

  return (
    <main className="mx-auto max-w-2xl px-6 py-14">
      <h1 className="text-3xl font-semibold tracking-tight text-slate-900">Nightingale</h1>
      <p className="mt-3 text-slate-600">
        A first-touch-to-care system for {clinic.name}. Someone frightened by what
        they found online gets the quality of questioning a doctor would give
        them — and none of the conclusions only a doctor may draw.
      </p>
      <p className="mt-2 text-sm text-slate-600">
        Synthetic data only. Not a real clinic, and not medical advice.
      </p>

      <h2 className="mt-10 text-sm font-medium uppercase tracking-wide text-slate-600">
        Try it
      </h2>
      <ul className="mt-3 divide-y divide-slate-200 rounded-lg border border-slate-200">
        {scenarios.map((s) => (
          <li key={s.href}>
            <Link href={s.href} className="block px-4 py-3 hover:bg-slate-50">
              <p className="font-medium text-teal-800">{s.title} →</p>
              <p className="text-sm text-slate-600">{s.note}</p>
            </Link>
          </li>
        ))}
      </ul>

      <p className="mt-3 text-sm text-slate-600">
        In any of them, type <strong>&ldquo;I have crushing chest pain&rdquo;</strong>{" "}
        and watch the profile fill, the checklist pause, and the handoff appear.
        That reply never reaches a language model.
      </p>

      <h2 className="mt-10 text-sm font-medium uppercase tracking-wide text-slate-600">
        Loaded configuration
      </h2>
      <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
        <Stat label="Red-flag rules" value={`${flags.red_flags.length}`} sub={`${variants} phrase variants, EN + BM + Manglish`} />
        <Stat label="Banned phrases" value={`${banned}`} sub={`${Object.keys(copy.banned).length} categories, checked after generation`} />
        <Stat label="History fields" value={`${fields}`} sub={`${Object.keys(checklists.complaint_types).length} clinical frames`} />
        <Stat label="Grounding chunks" value={`${getChunks().length}`} sub="citations resolve to character offsets" />
      </dl>

      <p className="mt-8 text-sm text-slate-600">
        Architecture, schema and the channel ethics matrix are in the Technical
        Brief; decisions and cuts are in PLANNING.md.
      </p>
    </main>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-lg border border-slate-200 px-3 py-2.5">
      <dt className="text-xs text-slate-600">{label}</dt>
      <dd className="text-xl font-semibold text-slate-900">{value}</dd>
      <dd className="text-xs text-slate-600">{sub}</dd>
    </div>
  );
}
