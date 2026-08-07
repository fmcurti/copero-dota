import { useEffect, useMemo, useRef, useState } from "react";
import { buildBeats } from "../game/beats";
import type { BracketMatch, GroupStanding, SimResult, SimTeam } from "../game/types";

// ---------------------------------------------------------------------------
// Broadcast reveal — the sim plays out as a sequence of timed beats:
//   Group tables (the humans' group last) → each bracket round (bot matches
//   land whole; human series tick game by game) → final standings.
// Solo: auto-advances locally with pause and skip.
// Versus: the room server drives the same renderer via `controlled`; the
//   host's pause/skip go back through `onControl`.
// ---------------------------------------------------------------------------

type Highlight = "self" | "human" | null;

function GroupTable({
  label,
  standings,
  hl,
}: {
  label: string;
  standings: GroupStanding[];
  hl: (t: SimTeam) => Highlight;
}) {
  return (
    <div className="flex-1 rounded-xl border border-ink-700 bg-ink-900/40 p-3">
      <div className="plate mb-2 text-sm tracking-widest text-slate-dim">Group {label}</div>
      <table className="w-full text-sm">
        <tbody>
          {standings.map((s, i) => {
            const h = hl(s.team);
            return (
              <tr
                key={s.team.id}
                className={`${
                  h === "self"
                    ? "bg-ink-700/50 font-bold text-bone"
                    : h === "human"
                      ? "font-semibold text-bone/75"
                      : "text-slate-strong"
                } ${i === 3 || i === 7 ? "border-b border-ink-600" : ""}`}
              >
                <td className="w-6 py-1 pl-2 font-mono text-xs text-slate-dim">{i + 1}</td>
                <td className="truncate py-1">{s.team.name}</td>
                <td className="py-1 pr-2 text-right font-mono text-xs">
                  {s.wins}–{s.losses}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="mt-1.5 flex justify-between px-2 text-[10px] text-slate-dim">
        <span>top 4 → upper bracket · 5–8 → lower</span>
        <span>9th out</span>
      </div>
    </div>
  );
}

// --- Bracket layout: columns per round, upper row + lower row, like a real
//     tournament bracket. Unrevealed matches show as TBD boxes. ---

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
  return (
    <div
      className={`flex items-center justify-between gap-2 px-2 py-1 text-xs ${
        decided && winner ? "font-bold" : ""
      } ${color}`}
    >
      <span className="truncate">{name}</span>
      <span className="font-mono">{score ?? "·"}</span>
    </div>
  );
}

function MatchBox({
  m,
  revealed,
  gamesShown,
  isGrandFinal,
  hl,
}: {
  m: BracketMatch;
  revealed: boolean;
  gamesShown?: number;
  isGrandFinal?: boolean;
  hl: (t: SimTeam) => Highlight;
}) {
  if (!revealed) {
    return (
      <div className="divide-y divide-ink-700/60 rounded border border-ink-700/70 bg-ink-900/30">
        <div className="px-2 py-1 text-xs italic text-slate-dim">TBD</div>
        <div className="px-2 py-1 text-xs italic text-slate-dim">TBD</div>
      </div>
    );
  }
  const partial = gamesShown != null && gamesShown < m.games.length;
  const shown = gamesShown ?? m.games.length;
  const scoreA = m.games.slice(0, shown).filter((g) => g === "a").length;
  const scoreB = shown - scoreA;
  const decided = !partial;
  const isHumanMatch = m.a.ownerId != null || m.b.ownerId != null;
  // Whose perspective the ●○ dots take: yours if you're in the match, else team A.
  const selfIsA = hl(m.a) === "self" ? true : hl(m.b) === "self" ? false : null;
  return (
    <div
      className={`divide-y rounded border ${
        isHumanMatch
          ? "divide-ink-600 border-slate-dim bg-ink-800/80"
          : "divide-ink-700/60 border-ink-700 bg-ink-900/50"
      }`}
    >
      <TeamLine
        name={m.a.name}
        score={scoreA}
        winner={m.winner.id === m.a.id}
        hl={hl(m.a)}
        decided={decided}
        champion={isGrandFinal && decided && m.winner.id === m.a.id}
      />
      <TeamLine
        name={m.b.name}
        score={scoreB}
        winner={m.winner.id === m.b.id}
        hl={hl(m.b)}
        decided={decided}
        champion={isGrandFinal && decided && m.winner.id === m.b.id}
      />
      {isHumanMatch && shown > 0 && (
        <div className="px-2 py-0.5 font-mono text-[10px] tracking-widest">
          {m.games.slice(0, shown).map((g, i) => {
            const refWon = (g === "a") === (selfIsA ?? true);
            const cls =
              selfIsA != null
                ? refWon
                  ? "text-bone"
                  : "text-slate-dim"
                : refWon
                  ? "text-slate-strong"
                  : "text-slate-dim";
            return (
              <span key={i} className={cls}>
                {refWon ? "●" : "○"}
              </span>
            );
          })}
          {partial && <span className="text-slate-dim"> · bo{m.bestOf}</span>}
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
              <div className="plate mb-1.5 text-center text-xs tracking-widest text-slate-dim">
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

function ChampionPlate({
  result,
  teamName,
  mine,
}: {
  result: SimResult;
  teamName: string;
  mine: { label: string; undefeated: boolean; flawlessGroup: boolean; gamesWon: number; gamesLost: number } | null;
}) {
  const humanChampion = result.champion.ownerId != null;
  return (
    <div className="plate-rules py-5 text-center">
      <div className="plate text-sm tracking-[0.4em] text-slate-dim">Campeón</div>
      <div
        className={`plate mt-1 text-4xl font-extrabold ${humanChampion ? "text-trophy" : "text-bone"}`}
      >
        {result.champion.name}
      </div>
      {mine && (
        <div className="mt-2 text-sm text-slate-mid">
          {teamName} — <span className="font-semibold text-slate-strong">{mine.label}</span> ·
          record{" "}
          <span className="font-mono">
            {mine.gamesWon}–{mine.gamesLost}
          </span>
        </div>
      )}
      <div className="mt-2 flex justify-center gap-2">
        {mine?.undefeated && (
          <span className="plate rounded-sm border border-trophy/70 px-2 py-0.5 text-sm font-bold tracking-widest text-trophy">
            322–0 · Flawless Copero
          </span>
        )}
        {mine && !mine.undefeated && mine.flawlessGroup && (
          <span className="plate rounded-sm border border-ink-600 px-2 py-0.5 text-sm text-slate-strong">
            Flawless group stage
          </span>
        )}
      </div>
    </div>
  );
}

export function Broadcast({
  result,
  teamName,
  footer,
  controlled,
  onControl,
  perspectiveOwnerId,
}: {
  result: SimResult;
  teamName: string;
  footer?: React.ReactNode;
  /** Versus mode: the server drives the reveal; disables the local timer. */
  controlled?: { idx: number; playing: boolean };
  /** Versus mode, host only: pause/resume/skip go to the server. */
  onControl?: (action: "pause" | "resume" | "skip") => void;
  /** Whose ●○ perspective and champion-plate line (defaults to the isUser team). */
  perspectiveOwnerId?: string;
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

  useEffect(() => {
    if (idx === 0) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [idx]);

  const persp =
    perspectiveOwnerId ??
    result.groupAssign.find((g) => g.team.isUser)?.team.ownerId ??
    null;
  const hl = (t: SimTeam): Highlight =>
    t.ownerId == null ? null : t.ownerId === persp ? "self" : "human";
  const mine = persp != null ? (result.ownerStats[persp] ?? null) : null;

  // Derive visibility from revealed beats
  const revealed = beats.slice(0, idx + 1);
  const groupsShown = revealed.filter((b) => b.kind === "group").map((b) => b.group);
  const roundsShown = new Set(
    revealed.filter((b) => b.kind === "round").map((b) => b.roundIdx),
  );
  const humanGames = new Map<string, number>();
  for (const b of revealed) {
    if (b.kind === "game") {
      const key = `${b.roundIdx}-${b.matchIdx}`;
      humanGames.set(key, Math.max(humanGames.get(key) ?? 0, b.upTo));
    }
  }
  const standingsShown = done;
  const showControls = !done && (controlled ? onControl != null : true);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div className="plate text-sm tracking-widest text-slate-dim">
          The International — Live
        </div>
        {showControls && (
          <div className="flex gap-2">
            <button
              onClick={() =>
                controlled
                  ? onControl?.(playing ? "pause" : "resume")
                  : setLocalPlaying((p) => !p)
              }
              className="rounded border border-ink-600 px-3 py-1 text-xs text-slate-strong hover:border-slate-mid"
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
              className="rounded border border-ink-600 px-3 py-1 text-xs text-slate-strong hover:border-slate-mid"
            >
              Skip to result
            </button>
          </div>
        )}
      </div>

      {groupsShown.length > 0 && (
        <div className="flex flex-col gap-4 sm:flex-row">
          {groupsShown.map((g) => (
            <div key={g} className="beat-in flex-1">
              <GroupTable label={g} standings={result.groups[g]} hl={hl} />
            </div>
          ))}
        </div>
      )}

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

      {standingsShown && (
        <div className="beat-in space-y-5">
          <ChampionPlate result={result} teamName={teamName} mine={mine} />
          <div className="rounded-xl border border-ink-700 bg-ink-900/40 p-3">
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
                    <span>
                      <span className="mr-2 inline-block w-12 font-mono text-xs text-slate-dim">
                        {s.label}
                      </span>
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
      <div ref={endRef} />
    </div>
  );
}
