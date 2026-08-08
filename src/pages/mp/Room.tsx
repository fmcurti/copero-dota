import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Broadcast } from "../../components/Broadcast";
import { OptionCard, Section } from "../../components/options";
import { ovrColor } from "../../components/cards";
import { useBundle, useHeroById } from "../../game/data";
import { SLOT_IDS } from "../../game/draft";
import { simulateTournament } from "../../game/sim";
import { useRunStore } from "../../game/store";
import type { Hero, SimResult } from "../../game/types";
import {
  MAX_SEATS,
  MIN_SEATS,
  makeRoomCode,
  type ClientMsg,
  type MpConfig,
  type RoomSnapshot,
  type Seat,
} from "../../mp/protocol";
import { DraftView } from "./DraftView";
import { useRoom } from "./useRoom";

export default function Room() {
  const { code = "" } = useParams();
  const teamName = useRunStore((s) => s.teamName);
  const { playerId, snapshot, send, spectate, takeSeat, lastError, locked } = useRoom(
    code,
    teamName || "Your Team",
  );
  const { bundle, error } = useBundle();
  const heroById = useHeroById(bundle);

  if (locked) {
    return (
      <div className="mx-auto max-w-md text-center">
        <div className="plate-rules py-6">
          <div className="plate text-2xl font-bold text-bone">Room {code}</div>
          <p className="mt-2 text-sm text-slate-mid">{locked}</p>
        </div>
        <Link
          to="/mp"
          className="mt-6 inline-block rounded-lg border border-ink-600 px-6 py-3 text-sm font-semibold text-slate-strong hover:border-slate-mid hover:text-bone"
        >
          Back to Versus
        </Link>
      </div>
    );
  }
  if (error) return <div className="text-dire">Failed to load data: {error}</div>;
  if (!snapshot || !bundle) {
    return <div className="text-center text-slate-dim">Conectando a la sala {code}…</div>;
  }

  const mySeat = snapshot.seats.findIndex((s) => s.playerId === playerId);
  const isHost = mySeat >= 0 && snapshot.seats[mySeat].isHost;
  const isSpectator = mySeat < 0;

  return (
    <div>
      {lastError && (
        <div className="mb-4 rounded-lg border border-dire/50 bg-ink-900/70 px-4 py-2 text-sm text-dire">
          {lastError}
        </div>
      )}
      {isSpectator && snapshot.phase !== "lobby" && (
        <div className="plate mb-4 rounded-lg border border-ink-700 bg-ink-900/50 px-4 py-2 text-center text-xs tracking-widest text-slate-mid">
          Spectating · room {code}
        </div>
      )}
      {snapshot.phase === "lobby" && (
        <LobbyView
          code={code}
          snapshot={snapshot}
          isHost={isHost}
          myId={playerId}
          send={send}
          onSpectate={spectate}
          onTakeSeat={takeSeat}
        />
      )}
      {snapshot.phase === "drafting" && snapshot.draft && (
        <DraftView
          snapshot={snapshot}
          mySeat={mySeat}
          send={send}
          bundle={bundle}
          heroById={heroById}
        />
      )}
      {snapshot.phase === "assembled" && (
        <AssembledView
          snapshot={snapshot}
          mySeat={mySeat}
          isHost={isHost}
          send={send}
          heroById={heroById}
        />
      )}
      {(snapshot.phase === "broadcasting" || snapshot.phase === "done") && (
        <BroadcastView
          code={code}
          snapshot={snapshot}
          mySeat={mySeat}
          isHost={isHost}
          playerId={playerId}
          send={send}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function SeatPlate({ seat }: { seat: Seat }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-ink-700 bg-ink-900/40 px-4 py-3">
      <span
        className={`h-2 w-2 shrink-0 rounded-full ${seat.connected ? "bg-bone" : "bg-ink-600"}`}
        title={seat.connected ? "connected" : "disconnected"}
      />
      <span className="min-w-0 flex-1 truncate text-sm font-bold text-bone">{seat.name}</span>
      {seat.isHost && (
        <span className="plate rounded-sm border border-ink-600 px-1.5 py-0.5 text-[10px] tracking-widest text-slate-dim">
          Host
        </span>
      )}
    </div>
  );
}

/** Your own seat in the lobby: the name is editable in place. */
function MySeatPlate({ seat, onRename }: { seat: Seat; onRename: (name: string) => void }) {
  const [value, setValue] = useState(seat.name);
  const commit = () => {
    const name = value.trim().slice(0, 30);
    if (!name) {
      setValue(seat.name);
      return;
    }
    if (name !== seat.name) onRename(name);
  };
  return (
    <div className="flex items-center gap-3 rounded-lg border border-bone/50 bg-ink-800 px-4 py-3">
      <span
        className={`h-2 w-2 shrink-0 rounded-full ${seat.connected ? "bg-bone" : "bg-ink-600"}`}
      />
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        maxLength={30}
        title="Edit your team name"
        className="min-w-0 flex-1 rounded-sm bg-transparent text-sm font-bold text-bone outline-none placeholder:text-slate-dim focus:bg-ink-900/60"
      />
      {seat.isHost && (
        <span className="plate rounded-sm border border-ink-600 px-1.5 py-0.5 text-[10px] tracking-widest text-slate-dim">
          Host
        </span>
      )}
      <span className="text-[10px] uppercase tracking-wide text-slate-dim">✎ you</span>
    </div>
  );
}

const TIMERS: { v: MpConfig["timerSecs"]; name: string; desc: string }[] = [
  { v: 7, name: "7s", desc: "Blitz — trust your gut." },
  { v: 15, name: "15s", desc: "Standard clock." },
  { v: 25, name: "25s", desc: "Thinking time." },
  { v: null, name: "Off", desc: "No clock, no mercy." },
];

function LobbyView({
  code,
  snapshot,
  isHost,
  myId,
  send,
  onSpectate,
  onTakeSeat,
}: {
  code: string;
  snapshot: RoomSnapshot;
  isHost: boolean;
  myId: string;
  send: (
    m: { t: "configure"; config: Partial<MpConfig> } | { t: "rename"; name: string } | { t: "start" },
  ) => void;
  onSpectate: () => void;
  onTakeSeat: () => void;
}) {
  const setTeamName = useRunStore((s) => s.setTeamName);
  const c = snapshot.config;
  const canStart = snapshot.seats.length >= MIN_SEATS;
  const isSpectator = !snapshot.seats.some((seat) => seat.playerId === myId);
  const canTakeSeat = snapshot.seats.length < MAX_SEATS;
  const set = (config: Partial<MpConfig>) => send({ t: "configure", config });
  const rename = (name: string) => {
    send({ t: "rename", name });
    setTeamName(name); // remember it for the next lobby / solo run
  };
  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div className="plate-rules py-4 text-center">
        <div className="plate text-sm tracking-[0.4em] text-slate-dim">Sala</div>
        <div className="plate mt-1 text-5xl font-extrabold tracking-[0.2em] text-bone">{code}</div>
        <p className="mt-2 text-xs text-slate-mid">
          pasale el código (o el link) a tus amigos — 2 a 8 drafters
        </p>
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {snapshot.seats.map((s) =>
          s.playerId === myId ? (
            <MySeatPlate key={s.playerId} seat={s} onRename={rename} />
          ) : (
            <SeatPlate key={s.playerId} seat={s} />
          ),
        )}
        {Array.from({ length: MAX_SEATS - snapshot.seats.length }, (_, i) => (
          <div
            key={`empty-${i}`}
            className="rounded-lg border border-dashed border-ink-700 px-4 py-3 text-sm text-slate-dim"
          >
            esperando drafter…
          </div>
        ))}
      </div>

      <div className="flex justify-center">
        {isSpectator ? (
          <button
            onClick={onTakeSeat}
            disabled={!canTakeSeat}
            className="rounded-lg border border-ink-600 px-5 py-2 text-sm font-semibold text-slate-strong hover:border-slate-mid hover:text-bone disabled:cursor-not-allowed disabled:opacity-40"
          >
            {canTakeSeat ? "Take an open seat" : "Spectating · room is full"}
          </button>
        ) : (
          <button
            onClick={onSpectate}
            className="rounded-lg border border-ink-600 px-5 py-2 text-sm font-semibold text-slate-strong hover:border-slate-mid hover:text-bone"
          >
            Sit this one out · spectate
          </button>
        )}
      </div>

      <div className="space-y-5">
        <Section label="Format">
          <OptionCard
            title="Valve Legacy"
            desc="Every International and Valve Major."
            selected={c.format === "valve_legacy"}
            onClick={() => set({ format: "valve_legacy" })}
            disabled={!isHost}
          />
          <OptionCard
            title="Standard"
            desc="Events from the last ~2 years."
            selected={c.format === "standard"}
            onClick={() => set({ format: "standard" })}
            disabled={!isHost}
          />
        </Section>
        <Section label="Player Cards">
          <OptionCard
            title="Career Average"
            desc="One card per pro, averaged across events."
            selected={c.cardMode === "career"}
            onClick={() => set({ cardMode: "career" })}
            disabled={!isHost}
          />
          <OptionCard
            title="Peak Form"
            desc="Best event blended with its neighbours."
            selected={c.cardMode === "peak"}
            onClick={() => set({ cardMode: "peak" })}
            disabled={!isHost}
          />
          <OptionCard
            title="Per Event"
            desc="Original style: one card per event."
            selected={c.cardMode === "event"}
            onClick={() => set({ cardMode: "event" })}
            disabled={!isHost}
          />
        </Section>
        <Section label="Player — Hero Allocation">
          <OptionCard
            title="Automatic"
            desc="Each hero is matched to the player who fits it best."
            selected={c.heroAlloc === "auto"}
            onClick={() => set({ heroAlloc: "auto" })}
            disabled={!isHost}
          />
          <OptionCard
            title="Manual"
            desc="Each drafter chooses which hero their players get before the tournament."
            selected={c.heroAlloc === "manual"}
            onClick={() => set({ heroAlloc: "manual" })}
            disabled={!isHost}
          />
        </Section>
        <Section label="Turn Timer">
          {TIMERS.map((t) => (
            <OptionCard
              key={String(t.v)}
              title={t.name}
              desc={t.desc}
              selected={c.timerSecs === t.v}
              onClick={() => set({ timerSecs: t.v })}
              disabled={!isHost}
            />
          ))}
        </Section>
        <Section label="Mulligans per drafter">
          {([0, 1, 2] as const).map((m) => (
            <OptionCard
              key={m}
              title={String(m)}
              desc={m === 0 ? "Open what you get." : m === 1 ? "One do-over." : "Comfy."}
              selected={c.mulligans === m}
              onClick={() => set({ mulligans: m })}
              disabled={!isHost}
            />
          ))}
        </Section>
      </div>

      {isHost ? (
        <button
          onClick={() => send({ t: "start" })}
          disabled={!canStart}
          className="plate w-full rounded-lg bg-bone py-4 text-xl font-bold tracking-widest text-ink-950 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
        >
          {canStart ? "Start Draft" : `Need ${MIN_SEATS}+ drafters`}
        </button>
      ) : isSpectator ? (
        <div className="text-center text-sm text-slate-dim">
          You’re spectating this lobby.
        </div>
      ) : (
        <div className="text-center text-sm text-slate-dim">
          esperando a que el host arranque el draft…
        </div>
      )}
    </div>
  );
}

function AssembledView({
  snapshot,
  mySeat,
  isHost,
  send,
  heroById,
}: {
  snapshot: RoomSnapshot;
  mySeat: number;
  isHost: boolean;
  send: (m: ClientMsg) => void;
  heroById: Map<number, Hero>;
}) {
  const { seats, strengths, field } = snapshot;
  const myBoard = mySeat >= 0 ? snapshot.draft?.boards[mySeat] : null;
  const myAssignment = mySeat >= 0 ? snapshot.heroAssignments?.[mySeat] : null;
  const myStrength = mySeat >= 0 ? strengths?.[mySeat] : null;
  const manual = snapshot.config.heroAlloc === "manual";
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="plate-rules py-3 text-center">
        <div className="plate text-2xl font-extrabold text-bone">Rosters locked</div>
        <div className="mt-1 text-xs text-slate-mid">
          {manual
            ? "adjust your hero assignments · one sim decides everything"
            : "heroes auto-assigned · field drawn · one sim decides everything"}
        </div>
      </div>

      {manual && myBoard && myAssignment && (
        <div className="rounded-xl border border-bone/40 bg-ink-900/40 p-4">
          <div className="plate mb-1 text-sm tracking-widest text-slate-dim">
            Your Hero Assignment
          </div>
          <p className="mb-3 text-xs text-slate-mid">
            Changing a hero swaps it with the player currently using it and updates your team OVR.
          </p>
          <div className="space-y-2">
            {SLOT_IDS.map((slot, playerIndex) => {
              const player = myBoard.slots[slot];
              if (!player) return null;
              const assigned = myStrength?.assignment[playerIndex];
              return (
                <div key={player.steamId} className="flex items-center gap-3">
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-strong">
                    {player.nickname}
                  </span>
                  <select
                    aria-label={`Hero for ${player.nickname}`}
                    value={myAssignment[String(player.steamId)] ?? ""}
                    onChange={(event) =>
                      send({
                        t: "assignHero",
                        steamId: player.steamId,
                        heroId: Number(event.target.value),
                      })
                    }
                    className="w-40 rounded border border-ink-600 bg-ink-900 px-2 py-1 text-sm text-slate-strong sm:w-52"
                  >
                    {myBoard.heroes.map((heroId) => (
                      <option key={heroId} value={heroId}>
                        {heroById.get(heroId)?.name ?? heroId}
                      </option>
                    ))}
                  </select>
                  <span className="w-12 text-right font-mono text-xs text-slate-dim">
                    {assigned?.games ?? 0}g
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {seats.map((s, i) => (
          <div
            key={s.playerId}
            className={`rounded-lg border p-3 text-center ${
              i === mySeat ? "border-bone/50 bg-ink-800" : "border-ink-700 bg-ink-900/40"
            }`}
          >
            <div className="truncate text-sm font-bold text-bone">{s.name}</div>
            <div className={`mt-1 font-mono text-3xl font-extrabold ${ovrColor(strengths?.[i]?.overall ?? 0)}`}>
              {strengths?.[i]?.overall ?? "—"}
            </div>
            <div className="mt-1 text-[10px] text-slate-dim">
              {strengths?.[i]
                ? `${strengths[i].base} +${strengths[i].heroBonus} hero +${strengths[i].chemBonus} chem`
                : ""}
            </div>
          </div>
        ))}
      </div>

      {field && (
        <div className="rounded-xl border border-ink-700 bg-ink-900/40 p-4">
          <div className="plate mb-2 text-sm tracking-widest text-slate-dim">
            The International — Field of 18
          </div>
          <div className="max-h-64 overflow-y-auto rounded bg-ink-800/50 p-2 text-sm">
            {[...field]
              .sort((a, b) => b.strength - a.strength)
              .map((t) => (
                <div
                  key={t.id}
                  className={`flex justify-between py-0.5 ${
                    t.ownerId != null ? "font-bold text-bone" : "text-slate-mid"
                  }`}
                >
                  <span>{t.name}</span>
                  <span className="font-mono text-xs">{t.strength}</span>
                </div>
              ))}
          </div>
        </div>
      )}

      {isHost ? (
        <button
          onClick={() => send({ t: "play" })}
          className="plate w-full rounded-lg bg-bone py-4 text-xl font-bold tracking-widest text-ink-950 transition hover:bg-white"
        >
          Play The International
        </button>
      ) : (
        <div className="text-center text-sm text-slate-dim">
          esperando a que el host apriete play…
        </div>
      )}
    </div>
  );
}

function BroadcastView({
  code,
  snapshot,
  mySeat,
  isHost,
  playerId,
  send,
}: {
  code: string;
  snapshot: RoomSnapshot;
  mySeat: number;
  isHost: boolean;
  playerId: string;
  send: (m: { t: "beat"; action: "pause" | "resume" | "skip" }) => void;
}) {
  const navigate = useNavigate();
  const recordRun = useRunStore((s) => s.recordRun);
  const { field, simSeed, beat, seats, config } = snapshot;
  const result: SimResult | null = useMemo(
    () => (field && simSeed != null ? simulateTournament(field, simSeed) : null),
    [field, simSeed],
  );
  const done = snapshot.phase === "done";
  const myName = mySeat >= 0 ? seats[mySeat].name : "Spectator";

  // Record my own result locally, once per (room, sim).
  useEffect(() => {
    if (!done || !result || mySeat < 0) return;
    const stats = result.ownerStats[playerId];
    if (!stats) return;
    const key = `copero-mp-recorded:${code}:${result.seed}`;
    if (localStorage.getItem(key)) return;
    localStorage.setItem(key, "1");
    const board = snapshot.draft?.boards[mySeat];
    recordRun({
      id: result.seed,
      date: Date.now(),
      place: stats.place,
      label: `${stats.label} · vs ${seats.length - 1} amigo${seats.length > 2 ? "s" : ""}`,
      overall: snapshot.strengths?.[mySeat]?.overall ?? 0,
      undefeated: stats.undefeated,
      flawlessGroup: stats.flawlessGroup,
      gamesWon: stats.gamesWon,
      gamesLost: stats.gamesLost,
      champion: result.champion.name,
      config: {
        format: config.format,
        cardMode: config.cardMode,
        rerolls: 0,
        heroAlloc: config.heroAlloc,
      },
      roster: board
        ? SLOT_IDS.map((slot, playerIndex) => {
            const p = board.slots[slot];
            return p
              ? {
                  nickname: p.nickname,
                  steamId: p.steamId,
                  role: p.role,
                  ovr: p.ovr,
                  heroId:
                    snapshot.strengths?.[mySeat]?.assignment[playerIndex]?.heroId ?? null,
                }
              : { nickname: "—", steamId: 0, role: "support" as const, ovr: 0, heroId: null };
          })
        : [],
    });
  }, [done, result, mySeat, playerId, code, recordRun, seats.length, snapshot, config]);

  if (!result || !beat) return <div className="text-slate-dim">Preparing broadcast…</div>;

  const humanStandings = seats
    .map((s) => ({ seat: s, stats: result.ownerStats[s.playerId] }))
    .filter((x) => x.stats)
    .sort((a, b) => a.stats.place - b.stats.place);

  return (
    <Broadcast
      key={result.seed}
      result={result}
      teamName={myName}
      perspectiveOwnerId={playerId}
      controlled={{ idx: beat.idx, playing: beat.playing }}
      onControl={isHost ? (action) => send({ t: "beat", action }) : undefined}
      footer={
        <div className="space-y-4">
          <div className="rounded-xl border border-ink-700 bg-ink-900/40 p-4">
            <div className="plate mb-2 text-sm tracking-widest text-slate-dim">
              El Copero — resultado entre amigos
            </div>
            <div className="space-y-1">
              {humanStandings.map(({ seat, stats }, i) => (
                <div
                  key={seat.playerId}
                  className={`flex items-baseline justify-between rounded px-2 py-1 text-sm ${
                    i === 0 ? "bg-ink-800/70 font-bold text-trophy" : "text-slate-strong"
                  }`}
                >
                  <span>
                    {i === 0 ? "🏆 " : ""}
                    {seat.name}
                    {seat.playerId === playerId ? " (you)" : ""}
                  </span>
                  <span className="font-mono text-xs">
                    {stats.label} · {stats.gamesWon}–{stats.gamesLost}
                  </span>
                </div>
              ))}
            </div>
          </div>
          <div className="flex gap-3">
            <button
              onClick={() => navigate("/mp")}
              className="flex-1 rounded-lg border border-ink-600 py-3 text-sm font-semibold text-slate-strong hover:border-slate-mid hover:text-bone"
            >
              Back to Versus
            </button>
            {isHost && (
              <button
                onClick={() => navigate(`/mp/${makeRoomCode()}`)}
                className="plate flex-1 rounded-lg bg-bone py-3 text-base font-bold tracking-widest text-ink-950 hover:bg-white"
              >
                Rematch (new room)
              </button>
            )}
          </div>
        </div>
      }
    />
  );
}
