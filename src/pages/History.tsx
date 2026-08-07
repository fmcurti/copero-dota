import { useRunStore } from "../game/store";

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

const CARD_MODE_LABEL: Record<string, string> = {
  career: "Career Avg",
  peak: "Peak Form",
  event: "Per Event",
};

export default function History() {
  const history = useRunStore((s) => s.history);
  if (!history.length) {
    return <div className="text-center text-slate-dim">No runs yet. Go win a Copero.</div>;
  }
  return (
    <div className="mx-auto max-w-3xl space-y-2">
      {history.map((r) => (
        <div
          key={`${r.id}-${r.date}`}
          className={`rounded-xl border p-4 ${
            r.place === 1 ? "border-trophy-dim/60 bg-ink-900/60" : "border-ink-700 bg-ink-900/40"
          }`}
        >
          <div className="flex items-baseline justify-between">
            <div className="text-lg font-bold">
              <span className={r.place === 1 ? "text-trophy" : "text-bone"}>
                {r.place === 1 ? "🏆 Campeón" : ordinal(r.place)}
              </span>
              {r.undefeated && (
                <span className="plate ml-2 rounded-sm border border-trophy/70 px-1.5 py-0.5 text-sm font-bold tracking-widest text-trophy">
                  322–0
                </span>
              )}
              {!r.undefeated && r.flawlessGroup && (
                <span className="plate ml-2 rounded-sm border border-ink-600 px-1.5 py-0.5 text-sm text-slate-strong">
                  flawless groups
                </span>
              )}
            </div>
            <div className="text-xs text-slate-dim">
              {new Date(r.date).toLocaleDateString()} · OVR{" "}
              <span className="font-mono text-slate-strong">{r.overall}</span> ·{" "}
              <span className="font-mono">
                {r.gamesWon}–{r.gamesLost}
              </span>{" "}
              · {CARD_MODE_LABEL[r.config.cardMode] ?? r.config.cardMode}
            </div>
          </div>
          <div className="mt-1 text-sm text-slate-mid">
            {r.roster.map((p) => p.nickname).join(" · ")}
          </div>
          {r.place !== 1 && (
            <div className="mt-0.5 text-xs text-slate-dim">champion: {r.champion}</div>
          )}
        </div>
      ))}
    </div>
  );
}
