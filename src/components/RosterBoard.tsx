import { SLOT_IDS, type Slots } from "../game/draft";
import { heroImage } from "../game/data";
import type { Hero, SlotId, TeamStrength } from "../game/types";
import { heroFitBonus } from "../game/strength";
import { ROLE_BAR, ovrColor } from "./cards";

const SLOT_LABEL: Record<SlotId, string> = {
  safelane: "Safelane",
  mid: "Mid",
  offlane: "Offlane",
  support1: "Support 4",
  support2: "Support 5",
};

/**
 * The phone-width companion to RosterBoard: one sticky bar over the pack with
 * the five role slots, the hero pool, and the team OVR — so a drafter scrolling
 * through cards never loses sight of what the team still needs. Hidden from lg
 * up, where the full board sits beside the pack.
 */
export function RosterStrip({
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
  return (
    <div className="panel sticky top-2 z-20 mb-3 flex items-center gap-2 rounded-lg px-2.5 py-2 lg:hidden">
      <div className="flex min-w-0 flex-1 gap-1.5">
        {SLOT_IDS.map((slotId) => {
          const p = slots[slotId];
          return (
            <div key={slotId} className="min-w-0 flex-1" title={SLOT_LABEL[slotId]}>
              <div className={`h-1 rounded ${p ? ROLE_BAR[p.role] : "bg-ink-700"}`} />
              <div
                className={`mt-1 truncate text-[10px] leading-tight ${
                  p ? "font-semibold text-slate-strong" : "text-slate-dim"
                }`}
              >
                {p ? p.nickname : SLOT_LABEL[slotId].replace("Support ", "Sup ")}
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex shrink-0 items-center gap-2 border-l border-ink-700/70 pl-2">
        <div className="flex -space-x-2" title={`Hero pool ${heroes.length}/5`}>
          {heroes.map((id) => (
            <img
              key={id}
              src={heroImage(heroById.get(id)?.picture)}
              alt={heroById.get(id)?.name ?? ""}
              className="h-4 w-[27px] rounded-[2px] border border-ink-900 object-cover"
            />
          ))}
          {Array.from({ length: 5 - heroes.length }, (_, i) => (
            <span key={i} className="h-4 w-[27px] rounded-[2px] border border-ink-900 bg-ink-800" />
          ))}
        </div>
        <span
          key={strength.overall}
          className={`anim-score-pop font-mono text-lg font-extrabold leading-none ${ovrColor(strength.overall)}`}
          title="Team OVR"
        >
          {strength.overall || "—"}
        </span>
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="plate mb-1.5 text-sm tracking-widest text-slate-dim">{children}</div>;
}

export function RosterBoard({
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
  return (
    <div className="panel rounded-xl p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="plate text-sm tracking-widest text-slate-dim">Your Roster</h2>
        <div className="flex items-baseline gap-2 font-mono" title="avg OVR + hero fit + chemistry">
          <span
            key={strength.overall}
            className={`anim-score-pop text-3xl font-extrabold ${ovrColor(strength.overall)}`}
          >
            {strength.overall || "—"}
          </span>
          <span className="text-[10px] uppercase text-slate-dim">Team OVR</span>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-1.5">
        {SLOT_IDS.map((slotId) => {
          const p = slots[slotId];
          const rosterIdx = p ? roster.indexOf(p) : -1;
          const assigned = rosterIdx >= 0 ? strength.assignment[rosterIdx] : null;
          const hero = assigned?.heroId != null ? heroById.get(assigned.heroId) : undefined;
          return (
            <div
              key={slotId}
              className="flex items-center gap-3 rounded-lg border border-ink-700/70 bg-ink-800/50 px-3 py-2"
            >
              <span className={`h-8 w-1 rounded ${p ? ROLE_BAR[p.role] : "bg-ink-700"}`} />
              <div className="w-20 shrink-0 text-[10px] uppercase tracking-wide text-slate-dim">
                {SLOT_LABEL[slotId]}
              </div>
              {p ? (
                <>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-bold text-bone">{p.nickname}</div>
                    <div className="truncate text-[11px] text-slate-dim">{p.team}</div>
                  </div>
                  {hero ? (
                    <div
                      className="flex items-center gap-2"
                      title={`${p.nickname} has ${assigned?.games ?? 0} career games on ${hero.name} → +${heroFitBonus(assigned?.games ?? 0)} team OVR`}
                    >
                      <img
                        src={heroImage(hero.picture)}
                        alt={hero.name}
                        className="h-7 w-[47px] rounded-sm object-cover"
                      />
                      <div className="w-14 text-right leading-tight">
                        <div className="truncate text-[10px] text-slate-mid">{hero.name}</div>
                        <div className="text-[10px] tabular-nums text-slate-dim">
                          {assigned?.games ?? 0}g
                          <span
                            className={`ml-1 font-mono font-bold ${
                              heroFitBonus(assigned?.games ?? 0) > 0
                                ? "text-slate-strong"
                                : "text-slate-dim"
                            }`}
                          >
                            +{heroFitBonus(assigned?.games ?? 0)}
                          </span>
                        </div>
                      </div>
                    </div>
                  ) : null}
                  <span className={`font-mono text-lg font-extrabold ${ovrColor(p.ovr)}`}>
                    {p.ovr}
                  </span>
                </>
              ) : (
                <div className="flex-1 text-sm text-slate-dim">empty</div>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-3">
        <SectionLabel>Hero Pool ({heroes.length}/5)</SectionLabel>
        <div className="flex flex-wrap gap-1.5">
          {heroes.map((id) => {
            const hero = heroById.get(id);
            return (
              <div
                key={id}
                className="flex items-center gap-1.5 rounded bg-ink-800/60 px-1.5 py-1"
                title={hero?.name}
              >
                <img
                  src={heroImage(hero?.picture)}
                  alt={hero?.name ?? ""}
                  className="h-5 w-[34px] rounded-sm object-cover"
                />
                <span className="text-xs text-slate-strong">{hero?.name}</span>
              </div>
            );
          })}
          {heroes.length === 0 && <span className="text-sm text-slate-dim">none yet</span>}
        </div>
      </div>

      {roster.length > 0 && (
        <div className="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
          <div className="rounded bg-ink-800/60 py-1.5">
            <div className="text-slate-dim">Base</div>
            <div className="font-mono font-bold text-slate-strong">{strength.base}</div>
          </div>
          <div className="rounded bg-ink-800/60 py-1.5" title="games played on assigned heroes">
            <div className="text-slate-dim">Hero fit</div>
            <div className="font-mono font-bold text-bone">+{strength.heroBonus}</div>
          </div>
          <div className="rounded bg-ink-800/60 py-1.5" title="games played together as teammates">
            <div className="text-slate-dim">Chemistry</div>
            <div className="font-mono font-bold text-bone">+{strength.chemBonus}</div>
          </div>
        </div>
      )}

      {roster.length >= 2 && (
        <div className="mt-3">
          <SectionLabel>Synergies</SectionLabel>
          {strength.chemTop.length ? (
            <div className="space-y-1">
              {strength.chemTop.map((c, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between rounded bg-ink-800/60 px-2 py-1 text-[11px]"
                  title={`${c.games} games played together → +${c.bonus} team OVR`}
                >
                  <span className="truncate text-slate-strong">{c.names.join(" + ")}</span>
                  <span className="ml-2 shrink-0 tabular-nums text-slate-dim">
                    {c.games}g
                    <span className="ml-1.5 font-mono font-bold text-bone">+{c.bonus}</span>
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-[11px] text-slate-dim">
              none yet — draft ex-teammates for a chemistry bonus
            </div>
          )}
        </div>
      )}
    </div>
  );
}
