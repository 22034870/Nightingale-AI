import { loadCopyRules, loadRedFlags } from "@/lib/config";

// Block B landing page: proves the deploy works and shows which safety configs
// actually loaded. Replaced by the real guest entry point in block D.
export default function Home() {
  let status: { label: string; detail: string; ok: boolean }[];

  try {
    const redFlags = loadRedFlags();
    const copy = loadCopyRules();
    const variantCount = redFlags.red_flags.reduce(
      (n, r) => n + r.variants.length,
      0,
    );
    const bannedCount = Object.values(copy.banned).reduce(
      (n, b) => n + b.patterns.length,
      0,
    );

    status = [
      {
        label: "Red-flag lexicon",
        detail: `${redFlags.red_flags.length} rules, ${variantCount} phrase variants (EN + BM + Manglish)`,
        ok: true,
      },
      {
        label: "Brief-mandated phrases",
        detail: `${redFlags.must_escalate_high.length} test fixtures that must classify High`,
        ok: true,
      },
      {
        label: "Copy rules",
        detail: `${bannedCount} banned phrases, ${Object.keys(copy.banned).length} categories`,
        ok: true,
      },
      {
        label: "Crisis protocol",
        detail: `${copy.crisis_protocol.resources.MY.length} MY + ${copy.crisis_protocol.resources.SG.length} SG helplines loaded`,
        ok: true,
      },
    ];
  } catch (err) {
    status = [
      {
        label: "Config load failed",
        detail: err instanceof Error ? err.message : String(err),
        ok: false,
      },
    ];
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center gap-8 px-6 py-16">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Nightingale</h1>
        <p className="mt-2 text-slate-600">
          Deployment is live. Safety configuration below is loaded from{" "}
          <code className="rounded bg-slate-100 px-1.5 py-0.5 text-sm">config/</code>{" "}
          at build time.
        </p>
      </div>

      <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200">
        {status.map((s) => (
          <li key={s.label} className="flex items-start gap-3 px-4 py-3">
            <span
              aria-hidden
              className={`mt-1.5 size-2 shrink-0 rounded-full ${
                s.ok ? "bg-teal-600" : "bg-red-600"
              }`}
            />
            <div>
              <p className="font-medium">{s.label}</p>
              <p className="text-sm text-slate-600">{s.detail}</p>
            </div>
          </li>
        ))}
      </ul>

      <p className="text-sm text-slate-500">
        Block B complete. Guest chat, redaction and the risk gate land in block D.
      </p>
    </main>
  );
}
