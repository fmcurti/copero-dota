import { SLOT_IDS, type Slots } from "../game/draft";
import { heroImage } from "../game/data";
import { heroFitBonus } from "../game/strength";
import type { Hero, SlotId, TeamStrength } from "../game/types";
import { ROLE_BAR, ovrColor } from "./cards";

// The draft, shown back at the end: who this team picked and on which hero.
// Used on both finish screens — solo (your own) and versus (per drafter).

const SLOT_LABEL: Record<SlotId, string> = {
  safelane: "Safelane",
  mid: "Mid",
  offlane: "Offlane",
  support1: "Support 4",
  support2: "Support 5",
};

export function DraftRecap({
  slots,
  heroes,
  strength,
  heroById,
}: {
  slots: Slots;
  heroes: number[];
  strength: TeamStrength;
  heroById: Map<number, Hero>;
}) {
  const roster = SLOT_IDS.map((s) => slots[s]).filter(Boolean);
  const assignedHeroIds = new Set(
    strength.assignment.map((a) => a.heroId).filter((h): h is number => h != null),
  );
  const spareHeroes = heroes.filter((h) => !assignedHeroIds.has(h));
  return (
    <div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {SLOT_IDS.map((slotId) => {
          const p = slots[slotId];
          const rosterIdx = p ? roster.indexOf(p) : -1;
          const assigned = rosterIdx >= 0 ? strength.assignment[rosterIdx] : null;
          const hero = assigned?.heroId != null ? heroById.get(assigned.heroId) : undefined;
          const fit = assigned ? heroFitBonus(assigned.games) : 0;
          return (
            <div
              key={slotId}
              className="overflow-hidden rounded-lg border border-ink-700 bg-ink-900/50"
            >
              {hero ? (
                <img
                  src={heroImage(hero.picture)}
                  alt={hero.name}
                  className="aspect-[47/28] w-full object-cover"
                />
              ) : (
                <div className="aspect-[47/28] w-full bg-ink-800" />
              )}
              <div className={`h-0.5 w-full ${p ? ROLE_BAR[p.role] : "bg-ink-700"}`} />
              <div className="p-2">
                <div className="text-[9px] uppercase tracking-widest text-slate-dim">
                  {SLOT_LABEL[slotId]}
                </div>
                {p ? (
                  <>
                    <div className="mt-0.5 flex items-baseline gap-1.5">
                      <span className="min-w-0 flex-1 truncate text-sm font-bold text-bone">
                        {p.nickname}
                      </span>
                      <span className={`font-mono text-sm font-extrabold ${ovrColor(p.ovr)}`}>
                        {p.ovr}
                      </span>
                    </div>
                    <div
                      className="truncate text-[11px] text-slate-mid"
                      title={
                        hero
                          ? `${p.nickname}: ${assigned?.games ?? 0}g on ${hero.name} → +${fit} team OVR`
                          : undefined
                      }
                    >
                      {hero?.name ?? "no hero"}
                      {hero && (
                        <span
                          className={`ml-1 font-mono tabular-nums ${fit > 0 ? "text-slate-strong" : "text-slate-dim"}`}
                        >
                          +{fit}
                        </span>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="mt-0.5 text-sm text-slate-dim">empty</div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] tabular-nums text-slate-dim">
        <span title="average OVR of drafted players">{strength.base} base</span>
        <span title="games played on assigned heroes">+{strength.heroBonus} fit</span>
        <span title="games played together as teammates">+{strength.chemBonus} chem</span>
        <span className="text-slate-mid">
          = <span className={`font-bold ${ovrColor(strength.overall)}`}>{strength.overall}</span> OVR
        </span>
        {spareHeroes.length > 0 && (
          <span className="ml-auto flex items-center gap-1">
            <span>unused</span>
            {spareHeroes.map((h) => (
              <img
                key={h}
                src={heroImage(heroById.get(h)?.picture)}
                alt={heroById.get(h)?.name ?? ""}
                title={`${heroById.get(h)?.name} — never assigned`}
                className="h-4 w-[27px] rounded-[2px] object-cover opacity-60"
              />
            ))}
          </span>
        )}
      </div>

      {strength.chemTop.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {strength.chemTop.map((c, i) => (
            <span
              key={i}
              title={`${c.games} games played together → +${c.bonus} team OVR`}
              className="rounded bg-ink-800/60 px-2 py-0.5 text-[11px] text-slate-mid"
            >
              {c.names.join(" + ")}
              <span className="ml-1.5 font-mono font-bold text-slate-strong">+{c.bonus}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
