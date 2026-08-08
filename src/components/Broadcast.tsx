import { useEffect, useMemo, useRef, useState } from "react";
import { buildBeats } from "../game/beats";
import type { BracketMatch, GroupStanding, SimResult, SimTeam } from "../game/types";

// ---------------------------------------------------------------------------
// Broadcast reveal — the sim plays out as a sequence of timed beats:
//   title card → live group ticker (rows climb and fall matchday by matchday)
//   → qualification cuts stamp in → each bracket round (bot series land
//   decided; human series get a VS clash strip and tick game by game)
//   → champion ceremony.
// Solo: auto-advances locally with pause and skip.
// Versus: the room server drives the same renderer via `controlled`; the
//   host's pause/skip go back through `onControl`.
// ---------------------------------------------------------------------------

type Highlight = "self" | "human" | null;

// ---- live group ticker ----------------------------------------------------

const ROW_H = 32; // px per standings row
const CUT_GAP = 10; // extra breathing room at the UB/LB/eliminated cuts

/** Standings after the first `days` matchdays — mirrors the sim's tiebreak. */
function standingsAfter(result: SimResult, group: "A" | "B", days: number): GroupStanding[] {
  const total = result.groupMatches.reduce((m, g) => Math.max(m, g.round + 1), 0);
  if (days >= total) return result.groups[group]; // final: use the sim's own table
  const teams = result.groupAssign.filter((g) => g.group === group).map((g) => g.team);
  const wins = new Map(teams.map((t) => [t.id, 0]));
  const losses = new Map(teams.map((t) => [t.id, 0]));
  for (const m of result.groupMatches) {
    if (m.group !== group || m.round >= days) continue;
    const aWins = m.games.filter((g) => g === "a").length;
    wins.set(m.a.id, wins.get(m.a.id)! + aWins);
    losses.set(m.a.id, losses.get(m.a.id)! + (m.games.length - aWins));
    wins.set(m.b.id, wins.get(m.b.id)! + (m.games.length - aWins));
    losses.set(m.b.id, losses.get(m.b.id)! + aWins);
  }
  return teams
    .map((t) => ({ team: t, wins: wins.get(t.id)!, losses: losses.get(t.id)! }))
    .sort(
      (x, y) =>
        y.wins - x.wins || y.team.strength - x.team.strength || x.team.id.localeCompare(y.team.id),
    );
}

/** What this team did on a given matchday: one entry per game. */
function dayGames(
  result: SimResult,
  teamId: string,
  group: string,
  day: number,
): { won: boolean; luck: boolean }[] {
  if (day < 0) return [];
  const out: { won: boolean; luck: boolean }[] = [];
  for (const m of result.groupMatches) {
    if (m.group !== group || m.round !== day) continue;
    if (m.a.id === teamId)
      m.games.forEach((g, i) => out.push({ won: g === "a", luck: m.luckGames?.[i]?.a ?? false }));
    else if (m.b.id === teamId)
      m.games.forEach((g, i) => out.push({ won: g === "b", luck: m.luckGames?.[i]?.b ?? false }));
  }
  return out;
}

function rowOffset(pos: number): number {
  return pos * ROW_H + (pos >= 4 ? CUT_GAP : 0) + (pos >= 8 ? CUT_GAP : 0);
}

function GroupBoard({
  label,
  result,
  upTo,
  days,
  stamped,
  hl,
}: {
  label: "A" | "B";
  result: SimResult;
  upTo: number; // matchdays already played
  days: number; // total matchdays
  stamped: boolean; // qualification cuts revealed
  hl: (t: SimTeam) => Highlight;
}) {
  // Rows render in a STABLE order (seeded group order) and only their
  // translateY changes — React never reorders the DOM nodes, so the CSS
  // transition animates every climb and fall.
  const teams = useMemo(
    () => result.groupAssign.filter((g) => g.group === label).map((g) => g.team),
    [result, label],
  );
  const standings = useMemo(() => standingsAfter(result, label, upTo), [result, label, upTo]);
  const byId = new Map(standings.map((s, i) => [s.team.id, { ...s, pos: i }]));
  const live = !stamped && upTo < days;
  const boardH = teams.length * ROW_H + 2 * CUT_GAP;
  return (
    <div className="panel flex-1 rounded-xl p-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="plate text-sm tracking-widest text-slate-dim">
          Group {label}
          <span className="ml-2 font-mono text-[10px] text-slate-dim/80">Bo2 round robin</span>
        </div>
        {live ? (
          <div className="flex items-center gap-1.5">
            <span className="live-dot" />
            <span className="plate text-xs tracking-widest text-slate-mid">
              {upTo === 0 ? "Jornada 1" : `Jornada ${upTo}/${days}`}
            </span>
          </div>
        ) : (
          <span className="plate text-xs tracking-widest text-slate-dim">Final</span>
        )}
      </div>

      <div className="relative" style={{ height: boardH }}>
        {/* qualification cut lines */}
        <div
          className="absolute inset-x-0 border-t border-dashed border-ink-600"
          style={{ top: 4 * ROW_H + CUT_GAP / 2 }}
        />
        <div
          className="absolute inset-x-0 border-t border-dashed border-ink-600"
          style={{ top: 8 * ROW_H + CUT_GAP + CUT_GAP / 2 }}
        />

        {teams.map((team) => {
          const s = byId.get(team.id)!;
          const p = s.pos;
          const h = hl(team);
          const today = dayGames(result, team.id, label, upTo - 1);
          const won = today.filter((t) => t.won).length;
          const net = won - (today.length - won);
          const zone = p < 4 ? "ub" : p < 8 ? "lb" : "out";
          return (
            <div
              key={s.team.id}
              className="absolute inset-x-0 will-change-transform"
              style={{
                transform: `translateY(${rowOffset(p)}px)`,
                transition: "transform 0.55s cubic-bezier(0.22, 1, 0.36, 1)",
                height: ROW_H,
              }}
            >
              {/* matchday result wash — remounts each tick */}
              {live && today.length > 0 && net !== 0 && (
                <span
                  key={`wash-${upTo}`}
                  className={`absolute inset-0 rounded ${net > 0 ? "anim-row-win" : "anim-row-loss"}`}
                />
              )}
              <div
                className={`relative flex h-full items-center gap-2 rounded px-2 text-sm ${
                  h === "self"
                    ? "font-bold text-bone"
                    : h === "human"
                      ? "font-semibold text-bone/75"
                      : stamped && zone === "out"
                        ? "text-slate-dim"
                        : "text-slate-strong"
                }`}
              >
                {h === "self" && <span className="absolute inset-y-1 left-0 w-0.5 rounded bg-trophy" />}
                <span className="w-5 shrink-0 font-mono text-xs text-slate-dim">{p + 1}</span>
                <span className="min-w-0 flex-1 truncate">{s.team.name}</span>
                {live && today.length > 0 && (
                  <span key={`dots-${upTo}`} className="flex shrink-0 items-center gap-1">
                    {today.map((t, i) => (
                      <span
                        key={i}
                        title={t.luck ? team.luck?.label : undefined}
                        className={`anim-dot-pop h-1.5 w-1.5 rounded-full ${
                          t.luck
                            ? "bg-trophy shadow-[0_0_6px_rgba(212,175,55,0.9)]"
                            : t.won
                              ? "bg-radiant"
                              : "bg-dire"
                        }`}
                        style={{ animationDelay: `${i * 0.12}s` }}
                      />
                    ))}
                  </span>
                )}
                {stamped && (
                  <span
                    className={`anim-stamp plate shrink-0 rounded-sm border px-1 py-px text-[9px] tracking-widest ${
                      zone === "ub"
                        ? "border-radiant-dim text-radiant"
                        : zone === "lb"
                          ? "border-ink-600 text-slate-mid"
                          : "border-dire-dim text-dire"
                    }`}
                    style={{ animationDelay: `${p * 0.06}s` }}
                  >
                    {zone === "ub" ? "Upper" : zone === "lb" ? "Lower" : "Out"}
                  </span>
                )}
                <span
                  key={`wl-${s.wins}-${s.losses}`}
                  className="anim-score-pop w-10 shrink-0 text-right font-mono text-xs tabular-nums"
                >
                  {s.wins}–{s.losses}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-2 flex justify-between px-2 text-[10px] text-slate-dim">
        <span>top 4 → upper bracket · 5–8 → lower</span>
        <span>9th out</span>
      </div>
    </div>
  );
}

// ---- bracket --------------------------------------------------------------

const UB_COLUMNS = [
  { roundIdx: 0, col: 1, label: "Round 1" },
  { roundIdx: 1, col: 3, label: "Semifinal" },
  { roundIdx: 2, col: 5, label: "Final" },
  { roundIdx: 9, col: 6, label: "Grand Final" },
];
const LB_COLUMNS = [
  { roundIdx: 3, col: 1, label: "Round 1" },
  { roundIdx: 4, col: 2, label: "Round 2" },
  { roundIdx: 5, col: 3, label: "Round 3" },
  { roundIdx: 6, col: 4, label: "Round 4" },
  { roundIdx: 7, col: 5, label: "Round 5" },
  { roundIdx: 8, col: 6, label: "Final" },
];

function TeamLine({
  name,
  score,
  winner,
  hl,
  decided,
  champion,
}: {
  name: string;
  score: number | null;
  winner: boolean;
  hl: Highlight;
  decided: boolean;
  champion?: boolean;
}) {
  const color = champion
    ? "text-trophy"
    : hl === "self"
      ? "text-bone"
      : hl === "human"
        ? "text-bone/75"
        : decided && winner
          ? "text-slate-strong"
          : "text-slate-mid";
  const scoreColor = champion
    ? "text-trophy"
    : decided && winner
      ? "text-radiant"
      : decided
        ? "text-slate-dim"
        : "text-slate-mid";
  return (
    <div
      className={`flex items-center justify-between gap-2 px-2 py-1 text-xs ${
        decided && winner ? "font-bold" : ""
      } ${color}`}
    >
      <span className="truncate">{name}</span>
      <span className={`font-mono font-bold ${scoreColor}`}>{score ?? "·"}</span>
    </div>
  );
}

function MatchBox({
  m,
  revealed,
  gamesShown,
  isGrandFinal,
  delay,
  hl,
}: {
  m: BracketMatch;
  revealed: boolean;
  gamesShown?: number;
  isGrandFinal?: boolean;
  delay: number;
  hl: (t: SimTeam) => Highlight;
}) {
  if (!revealed) {
    return (
      <div className="divide-y divide-ink-700/50 rounded border border-dashed border-ink-700/70 bg-ink-900/20">
        <div className="px-2 py-1 text-xs italic text-slate-dim/70">TBD</div>
        <div className="px-2 py-1 text-xs italic text-slate-dim/70">TBD</div>
      </div>
    );
  }
  const partial = gamesShown != null && gamesShown < m.games.length;
  const shown = gamesShown ?? m.games.length;
  const scoreA = m.games.slice(0, shown).filter((g) => g === "a").length;
  const scoreB = shown - scoreA;
  const decided = !partial;
  const isHumanMatch = m.a.ownerId != null || m.b.ownerId != null;
  // Whose perspective the dots take: yours if you're in the match, else team A.
  const selfIsA = hl(m.a) === "self" ? true : hl(m.b) === "self" ? false : null;
  return (
    <div
      className={`beat-in divide-y rounded border ${isHumanMatch ? "anim-sweep" : ""} ${
        isHumanMatch
          ? "divide-ink-600 border-slate-dim bg-ink-800/80"
          : "divide-ink-700/60 border-ink-700 bg-ink-900/50"
      }`}
      style={{ animationDelay: `${delay}s` }}
    >
      <TeamLine
        name={m.a.name}
        score={shown > 0 || decided ? scoreA : null}
        winner={m.winner.id === m.a.id}
        hl={hl(m.a)}
        decided={decided}
        champion={isGrandFinal && decided && m.winner.id === m.a.id}
      />
      <TeamLine
        name={m.b.name}
        score={shown > 0 || decided ? scoreB : null}
        winner={m.winner.id === m.b.id}
        hl={hl(m.b)}
        decided={decided}
        champion={isGrandFinal && decided && m.winner.id === m.b.id}
      />
      {isHumanMatch && shown > 0 && (
        <div className="flex items-center gap-1 px-2 py-1">
          {m.games.slice(0, shown).map((g, i) => {
            const refWon = (g === "a") === (selfIsA ?? true);
            const procced = m.luckGames?.[i]?.a || m.luckGames?.[i]?.b;
            return (
              <span
                key={i}
                title={procced ? (m.a.luck?.label ?? m.b.luck?.label) : undefined}
                className={`h-1.5 w-1.5 rounded-full ${
                  i === shown - 1 ? "anim-dot-pop" : ""
                } ${
                  procced
                    ? "bg-trophy shadow-[0_0_6px_rgba(212,175,55,0.9)]"
                    : refWon
                      ? "bg-radiant"
                      : "bg-dire"
                }`}
              />
            );
          })}
          {partial && (
            <span className="ml-1 font-mono text-[10px] text-slate-dim">bo{m.bestOf}</span>
          )}
        </div>
      )}
    </div>
  );
}

function BracketSection({
  title,
  columns,
  rounds,
  roundsShown,
  humanGames,
  hl,
}: {
  title: string;
  columns: { roundIdx: number; col: number; label: string }[];
  rounds: SimResult["rounds"];
  roundsShown: Set<number>;
  humanGames: Map<string, number>;
  hl: (t: SimTeam) => Highlight;
}) {
  return (
    <div>
      <div className="plate mb-2 text-sm tracking-widest text-slate-dim">{title}</div>
      <div className="grid grid-cols-6 gap-3">
        {columns.map(({ roundIdx, col, label }) => {
          const round = rounds[roundIdx];
          if (!round) return null;
          return (
            <div key={roundIdx} className="flex flex-col" style={{ gridColumnStart: col }}>
              <div
                className={`plate mb-1.5 text-center text-xs tracking-widest ${
                  roundsShown.has(roundIdx) ? "text-slate-mid" : "text-slate-dim/70"
                }`}
              >
                {label}
              </div>
              <div className="flex flex-1 flex-col justify-around gap-2">
                {round.matches.map((m, matchIdx) => (
                  <MatchBox
                    key={m.id}
                    m={m}
                    revealed={roundsShown.has(roundIdx)}
                    gamesShown={
                      m.a.ownerId != null || m.b.ownerId != null
                        ? (humanGames.get(`${roundIdx}-${matchIdx}`) ?? 0)
                        : undefined
                    }
                    isGrandFinal={roundIdx === 9}
                    delay={matchIdx * 0.09}
                    hl={hl}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---- clash strip (fixed lower third for human series) ---------------------

function ClashPlate({
  team,
  side,
  hl,
  state,
}: {
  team: SimTeam;
  side: "l" | "r";
  hl: Highlight;
  state: "live" | "won" | "lost";
}) {
  const edge =
    state === "won"
      ? "border-radiant/70"
      : state === "lost"
        ? "border-dire-dim/70"
        : hl === "self"
          ? "border-trophy/60"
          : hl === "human"
            ? "border-bone/40"
            : "border-ink-600";
  return (
    <div
      className={`panel flex min-w-0 flex-1 items-center gap-3 border px-4 py-2.5 ${edge} ${
        side === "l" ? "angled-l anim-slam-l justify-end text-right" : "angled-r anim-slam-r"
      } ${state === "lost" ? "opacity-60" : ""}`}
    >
      <div className="min-w-0">
        <div
          className={`plate-italic truncate text-lg leading-tight sm:text-xl ${
            hl === "self" ? "text-bone" : hl === "human" ? "text-bone/80" : "text-slate-strong"
          }`}
        >
          {team.name}
        </div>
        <div className="font-mono text-[10px] text-slate-dim">
          {team.ownerId != null ? "drafter" : `str ${team.strength}`}
        </div>
      </div>
    </div>
  );
}

function ClashStrip({
  m,
  roundName,
  shown,
  taunt,
  hl,
}: {
  m: BracketMatch;
  roundName: string;
  shown: number;
  /** The winner's victory phrase, shown once the series is over. */
  taunt: string | null;
  hl: (t: SimTeam) => Highlight;
}) {
  const scoreA = m.games.slice(0, shown).filter((g) => g === "a").length;
  const scoreB = shown - scoreA;
  const over = shown >= m.games.length;
  const aWon = m.winner.id === m.a.id;
  // The freshly landed game — did somebody's luck trait fire?
  const lastLuck = shown > 0 ? m.luckGames?.[shown - 1] : undefined;
  const luckLabel = lastLuck?.a ? m.a.luck?.label : lastLuck?.b ? m.b.luck?.label : null;
  return (
    <div className="pointer-events-none fixed bottom-4 left-1/2 z-40 w-[min(880px,94vw)] -translate-x-1/2">
      <div className="relative">
        <div className="mb-1 text-center">
          <span className="angled plate inline-block bg-ink-800/95 px-4 py-0.5 text-[10px] tracking-[0.3em] text-slate-mid shadow-lg">
            {roundName}
          </span>
        </div>
        <div className="flex items-stretch gap-2 drop-shadow-2xl">
          <ClashPlate
            team={m.a}
            side="l"
            hl={hl(m.a)}
            state={over ? (aWon ? "won" : "lost") : "live"}
          />
          <div className="flex w-24 shrink-0 flex-col items-center justify-center rounded border border-ink-600 bg-ink-950/95 px-2 py-1">
            {shown === 0 ? (
              <span className="anim-vs-pop plate-italic gold-text text-3xl">VS</span>
            ) : (
              <div className="flex items-baseline gap-1.5 font-mono text-2xl font-extrabold tabular-nums">
                <span key={`a${scoreA}`} className={`anim-score-pop ${over && aWon ? "text-radiant" : "text-bone"}`}>
                  {scoreA}
                </span>
                <span className="text-sm text-slate-dim">–</span>
                <span key={`b${scoreB}`} className={`anim-score-pop ${over && !aWon ? "text-radiant" : "text-bone"}`}>
                  {scoreB}
                </span>
              </div>
            )}
            <span className="font-mono text-[9px] uppercase tracking-widest text-slate-dim">
              bo{m.bestOf}
            </span>
          </div>
          <ClashPlate
            team={m.b}
            side="r"
            hl={hl(m.b)}
            state={over ? (aWon ? "lost" : "won") : "live"}
          />
          {/* impact flash over the plates on entry */}
          <span className="anim-clash-flash absolute inset-0 z-10 rounded-lg bg-gradient-to-r from-transparent via-bone/25 to-transparent" />
        </div>
        {luckLabel && (
          <div key={`luck-${shown}`} className="mt-1 text-center">
            <span
              className="anim-stamp plate-italic inline-block rounded-sm border-2 border-trophy bg-ink-950/95 px-4 py-1 text-lg tracking-widest text-trophy"
              style={{ boxShadow: "0 0 24px rgba(212,175,55,0.45)" }}
            >
              ⚡ {luckLabel}
            </span>
          </div>
        )}
        {over && (
          <div className="mt-1 text-center">
            <span className="anim-stamp plate inline-block rounded-sm border border-radiant-dim/70 bg-ink-950/90 px-3 py-0.5 text-xs tracking-widest text-radiant">
              {m.winner.name} se lleva la serie
            </span>
          </div>
        )}
        {taunt && (
          <div className="anim-taunt mt-2 text-center">
            <div
              className="plate-italic inline-block max-w-full truncate rounded-md border-2 border-dire bg-ink-950/95 px-6 py-2.5 text-xl normal-case text-bone sm:text-2xl"
              style={{ boxShadow: "0 0 30px rgba(226, 87, 70, 0.4)" }}
            >
              “{taunt}”
            </div>
            <div className="mt-1.5 text-[10px] uppercase tracking-[0.35em] text-slate-mid">
              — {m.winner.name}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---- ceremony -------------------------------------------------------------

function ChampionPlate({
  result,
  teamName,
  mine,
}: {
  result: SimResult;
  teamName: string;
  mine: {
    label: string;
    undefeated: boolean;
    flawlessGroup: boolean;
    gamesWon: number;
    gamesLost: number;
  } | null;
}) {
  const humanChampion = result.champion.ownerId != null;
  return (
    <div className="panel relative overflow-hidden rounded-2xl py-10 text-center">
      <div className="rays" />
      {humanChampion && (
        <>
          <span className="spark" />
          <span className="spark" />
          <span className="spark" />
          <span className="spark" />
          <span className="spark" />
          <span className="spark" />
          <span className="spark" />
          <span className="spark" />
        </>
      )}
      <div className="relative">
        <div className="anim-eyebrow-in plate text-sm text-trophy-dim">Campeón</div>
        {/* entry animation on the wrapper, shimmer on the inner span — both
            set `animation`, so they can't share one element */}
        <div className="anim-title-in mt-2" style={{ animationDelay: "0.15s" }}>
          <span
            className={`plate text-5xl font-extrabold leading-none sm:text-6xl ${
              humanChampion ? "gold-shimmer" : "text-bone"
            }`}
          >
            {result.champion.name}
          </span>
        </div>
        <div className="anim-title-in mt-2 text-xs tracking-[0.25em] text-slate-mid" style={{ animationDelay: "0.35s" }}>
          ALZA EL AEGIS
        </div>
        {mine && (
          <div className="beat-in mt-4 text-sm text-slate-mid" style={{ animationDelay: "0.5s" }}>
            {teamName} — <span className="font-semibold text-slate-strong">{mine.label}</span> ·
            record{" "}
            <span className="font-mono">
              {mine.gamesWon}–{mine.gamesLost}
            </span>
          </div>
        )}
        <div className="mt-3 flex justify-center gap-2">
          {mine?.undefeated && (
            <span
              className="anim-stamp plate rounded-sm border-2 border-trophy px-3 py-1 text-base font-bold tracking-widest text-trophy"
              style={{ animationDelay: "0.7s", boxShadow: "0 0 24px rgba(212,175,55,0.25)" }}
            >
              322–0 · Flawless Copero
            </span>
          )}
          {mine && !mine.undefeated && mine.flawlessGroup && (
            <span
              className="anim-stamp plate rounded-sm border border-ink-600 px-2 py-0.5 text-sm text-slate-strong"
              style={{ animationDelay: "0.7s" }}
            >
              Flawless group stage
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ---- the broadcast --------------------------------------------------------

export function Broadcast({
  result,
  teamName,
  footer,
  controlled,
  onControl,
  perspectiveOwnerId,
  serverTaunt,
}: {
  result: SimResult;
  teamName: string;
  footer?: React.ReactNode;
  /** Versus mode: the server drives the reveal; disables the local timer. */
  controlled?: { idx: number; playing: boolean };
  /** Versus mode, host only: pause/resume/skip go to the server. */
  onControl?: (action: "pause" | "resume" | "skip") => void;
  /** Whose dots perspective and champion-plate line (defaults to the isUser team). */
  perspectiveOwnerId?: string;
  /**
   * Versus mode: the winner's victory phrase for the current taunt beat.
   * Phrases are server-side secrets; this is the only one clients ever get.
   */
  serverTaunt?: { ownerId: string; phrase: string } | null;
}) {
  const beats = useMemo(() => buildBeats(result), [result]);
  const [localIdx, setLocalIdx] = useState(0);
  const [localPlaying, setLocalPlaying] = useState(true);
  const idx = controlled ? Math.min(controlled.idx, beats.length - 1) : localIdx;
  const playing = controlled ? controlled.playing : localPlaying;
  const done = idx >= beats.length - 1;
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (controlled || !playing || done) return;
    const t = setTimeout(() => setLocalIdx((i) => i + 1), beats[idx].ms);
    return () => clearTimeout(t);
  }, [controlled, playing, done, idx, beats]);

  const cur = beats[idx];

  // Scroll only when a new section lands (never during the group ticker).
  useEffect(() => {
    if (idx === 0) return;
    const b = beats[idx];
    const mounts =
      b.kind === "round" ||
      b.kind === "standings" ||
      b.kind === "groupDone" ||
      (b.kind === "groupRound" && b.upTo === 0);
    if (!mounts) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [idx, beats]);

  const persp =
    perspectiveOwnerId ??
    result.groupAssign.find((g) => g.team.isUser)?.team.ownerId ??
    null;
  const hl = (t: SimTeam): Highlight =>
    t.ownerId == null ? null : t.ownerId === persp ? "self" : "human";
  const mine = persp != null ? (result.ownerStats[persp] ?? null) : null;

  // Derive visibility from revealed beats.
  const revealed = beats.slice(0, idx + 1);
  const days = result.groupMatches.reduce((m, g) => Math.max(m, g.round + 1), 0);
  let groupUpTo: number | null = null;
  let groupsStamped = false;
  const roundsShown = new Set<number>();
  const humanGames = new Map<string, number>();
  for (const b of revealed) {
    if (b.kind === "groupRound") groupUpTo = Math.max(groupUpTo ?? 0, b.upTo);
    else if (b.kind === "groupDone") groupsStamped = true;
    else if (b.kind === "round") roundsShown.add(b.roundIdx);
    else if (b.kind === "game") {
      const key = `${b.roundIdx}-${b.matchIdx}`;
      humanGames.set(key, Math.max(humanGames.get(key) ?? 0, b.upTo));
    }
  }
  const clash =
    !done && (cur.kind === "clash" || cur.kind === "game" || cur.kind === "taunt")
      ? { roundIdx: cur.roundIdx, matchIdx: cur.matchIdx }
      : null;
  const clashMatch = clash ? result.rounds[clash.roundIdx]?.matches[clash.matchIdx] : null;

  // Victory phrase: the server resolves it for the current taunt beat and
  // sends exactly one — sanity-check it belongs to this match's winner.
  const taunt =
    cur.kind === "taunt" && clashMatch && serverTaunt?.ownerId === clashMatch.winner.ownerId
      ? serverTaunt.phrase
      : null;

  const phaseLabel = done
    ? "Ceremonia"
    : cur.kind === "intro"
      ? "Opening"
      : cur.kind === "groupRound" || cur.kind === "groupDone"
        ? `Fase de Grupos${cur.kind === "groupRound" && cur.upTo > 0 ? ` · Jornada ${cur.upTo}/${days}` : ""}`
        : cur.kind === "standings"
          ? "Ceremonia"
          : result.rounds[cur.roundIdx]?.name ?? "";

  const showControls = !done && (controlled ? onControl != null : true);

  return (
    <div className="space-y-5">
      {/* broadcast bar */}
      <div className="sticky top-2 z-30 flex items-center justify-between rounded-lg border border-ink-700/70 bg-ink-950/85 px-3 py-2 backdrop-blur">
        <div className="flex min-w-0 items-center gap-2.5">
          {!done && <span className="live-dot shrink-0" />}
          <span className="plate shrink-0 text-sm tracking-widest text-bone">
            The International
          </span>
          <span className="hidden truncate text-xs text-slate-mid sm:inline">— {phaseLabel}</span>
        </div>
        {showControls && (
          <div className="flex shrink-0 gap-2">
            <button
              onClick={() =>
                controlled
                  ? onControl?.(playing ? "pause" : "resume")
                  : setLocalPlaying((p) => !p)
              }
              className="rounded border border-ink-600 px-3 py-1 text-xs text-slate-strong transition hover:border-slate-mid hover:text-bone"
            >
              {playing ? "Pause" : "Resume"}
            </button>
            <button
              onClick={() => {
                if (controlled) {
                  onControl?.("skip");
                } else {
                  setLocalIdx(beats.length - 1);
                  setLocalPlaying(false);
                }
              }}
              className="rounded border border-ink-600 px-3 py-1 text-xs text-slate-strong transition hover:border-slate-mid hover:text-bone"
            >
              Skip to result
            </button>
          </div>
        )}
      </div>

      {/* title card */}
      <div className="anim-title-in plate-rules py-5 text-center">
        <div className="anim-eyebrow-in plate text-xs text-slate-dim">El Copero presenta</div>
        <div className="plate mt-1 text-4xl font-extrabold leading-none text-bone sm:text-5xl">
          The <span className="gold-text">International</span>
        </div>
        <div className="mt-1.5 text-xs tracking-[0.3em] text-slate-mid">
          18 EQUIPOS · UN AEGIS
        </div>
      </div>

      {/* live group ticker */}
      {groupUpTo != null && (
        <div className="beat-in flex flex-col gap-4 sm:flex-row">
          <GroupBoard
            label="A"
            result={result}
            upTo={groupUpTo}
            days={days}
            stamped={groupsStamped}
            hl={hl}
          />
          <GroupBoard
            label="B"
            result={result}
            upTo={groupUpTo}
            days={days}
            stamped={groupsStamped}
            hl={hl}
          />
        </div>
      )}

      {/* bracket */}
      {roundsShown.size > 0 && (
        <div className="beat-in overflow-x-auto">
          <div className="min-w-[860px] space-y-6">
            <BracketSection
              title="Upper Bracket"
              columns={UB_COLUMNS}
              rounds={result.rounds}
              roundsShown={roundsShown}
              humanGames={humanGames}
              hl={hl}
            />
            <BracketSection
              title="Lower Bracket"
              columns={LB_COLUMNS}
              rounds={result.rounds}
              roundsShown={roundsShown}
              humanGames={humanGames}
              hl={hl}
            />
          </div>
        </div>
      )}

      {/* champion ceremony + final standings */}
      {done && (
        <div className="beat-in space-y-5">
          <ChampionPlate result={result} teamName={teamName} mine={mine} />
          <div className="panel rounded-xl p-3">
            <div className="plate mb-2 text-sm tracking-widest text-slate-dim">
              Final Standings
            </div>
            <div className="grid grid-cols-1 gap-x-6 sm:grid-cols-2">
              {result.standings.map((s, i) => {
                const h = hl(s.team);
                return (
                  <div
                    key={`${s.team.id}-${i}`}
                    className={`flex justify-between border-b border-ink-700/40 py-1 text-sm ${
                      h === "self"
                        ? "font-bold text-bone"
                        : h === "human"
                          ? "font-semibold text-bone/75"
                          : "text-slate-strong"
                    } ${s.place === 1 ? "text-trophy" : ""}`}
                  >
                    <span className="min-w-0 truncate">
                      <span className="mr-2 inline-block w-12 font-mono text-xs text-slate-dim">
                        {s.label}
                      </span>
                      {s.place === 1 && "🏆 "}
                      {s.team.name}
                    </span>
                    <span className="font-mono text-xs text-slate-dim">{s.team.strength}</span>
                  </div>
                );
              })}
            </div>
          </div>
          {footer}
        </div>
      )}

      {/* clash strip — fixed lower third while a human series plays */}
      {clashMatch && clash && (
        <ClashStrip
          key={`${clash.roundIdx}-${clash.matchIdx}`}
          m={clashMatch}
          roundName={result.rounds[clash.roundIdx].name}
          shown={
            cur.kind === "taunt"
              ? clashMatch.games.length
              : (humanGames.get(`${clash.roundIdx}-${clash.matchIdx}`) ?? 0)
          }
          taunt={taunt}
          hl={hl}
        />
      )}
      <div ref={endRef} />
    </div>
  );
}
