import type { ReactNode } from "react";
import { heroImage } from "../game/data";
import type { Hero, RosterPlayer, Role } from "../game/types";

export const ROLE_LABEL: Record<Role, string> = {
  safelane: "Safelane",
  mid: "Mid",
  offlane: "Offlane",
  support: "Support",
};

export const ROLE_BAR: Record<Role, string> = {
  safelane: "bg-role-safelane",
  mid: "bg-role-mid",
  offlane: "bg-role-offlane",
  support: "bg-role-support",
};

export const ROLE_BADGE: Record<Role, string> = {
  safelane: "border-role-safelane/50 text-role-safelane",
  mid: "border-role-mid/50 text-role-mid",
  offlane: "border-role-offlane/50 text-role-offlane",
  support: "border-role-support/50 text-role-support",
};

/** Gold is earned: only 90+ ratings wear the trophy color. */
export function ovrColor(ovr: number): string {
  if (ovr >= 90) return "text-trophy";
  if (ovr >= 85) return "text-bone";
  if (ovr >= 80) return "text-slate-strong";
  return "text-slate-mid";
}

export function CardButton({
  disabled,
  onPick,
  delay = 0,
  children,
}: {
  disabled?: boolean;
  onPick?: () => void;
  delay?: number;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onPick}
      disabled={disabled}
      style={{ animationDelay: `${delay}s` }}
      className={`card-flip relative flex aspect-[2/3] w-[calc(33.333%-0.5rem)] flex-col overflow-hidden rounded-lg border shadow-lg transition sm:w-[calc(20%-0.6rem)] ${
        disabled
          ? "cursor-not-allowed border-ink-700 opacity-30 grayscale"
          : "border-ink-600 hover:-translate-y-1 hover:border-slate-mid"
      }`}
    >
      {children}
    </button>
  );
}

function Stat({ label, v, help }: { label: string; v: number; help: string }) {
  return (
    <div title={help}>
      <div className="text-[9px] uppercase tracking-wide text-slate-dim">{label}</div>
      <div className="font-mono text-xs font-semibold text-slate-strong sm:text-sm">{v}</div>
    </div>
  );
}

export function PlayerCardContent({ p, subtitle }: { p: RosterPlayer; subtitle?: string }) {
  return (
    <>
      <div className={`h-1.5 ${ROLE_BAR[p.role]}`} />
      <div className="flex flex-1 flex-col bg-ink-800/80 p-2.5 text-left sm:p-3">
        <span
          className={`plate self-start rounded-sm border px-1.5 py-0.5 text-[11px] font-semibold ${ROLE_BADGE[p.role]}`}
        >
          {ROLE_LABEL[p.role]}
        </span>
        <div className="mt-2 truncate text-sm font-bold text-bone sm:text-base">{p.nickname}</div>
        {subtitle ? <div className="truncate text-[11px] text-slate-dim">{subtitle}</div> : null}
        <div className="mt-2.5 grid grid-cols-3 gap-0.5 text-center">
          <Stat label="IMP" v={p.impact} help="Impact — kills, assists, kill participation, damage" />
          <Stat label="ECO" v={p.economy} help="Economy — GPM / XPM / last hits" />
          <Stat label="REL" v={p.reliability} help="Reliability — game-to-game consistency" />
        </div>
        <div className="mt-auto flex items-baseline gap-1.5 border-t border-ink-700/60 pb-0.5 pt-2.5">
          <span
            className={`font-mono text-3xl font-extrabold leading-none sm:text-4xl ${ovrColor(p.ovr)}`}
          >
            {p.ovr}
          </span>
          <span className="text-[10px] uppercase tracking-wide text-slate-dim">OVR</span>
        </div>
      </div>
    </>
  );
}

export function HeroCardContent({ hero }: { hero: Hero | undefined }) {
  return (
    <div className="flex flex-1 flex-col bg-ink-800/80">
      <div className="px-2.5 pt-2.5">
        <span className="plate rounded-sm bg-ink-900/70 px-1.5 py-0.5 text-[11px] font-semibold text-slate-mid">
          Hero
        </span>
      </div>
      <img src={heroImage(hero?.picture)} alt={hero?.name ?? ""} className="mt-2 w-full" />
      <div className="mt-auto truncate p-2.5 text-center text-base font-bold text-bone">
        {hero?.name}
      </div>
    </div>
  );
}
