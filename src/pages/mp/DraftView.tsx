import { useEffect, useMemo, useState } from "react";
import { CardButton, HeroCardContent, PlayerCardContent, ROLE_BAR, ovrColor } from "../../components/cards";
import { SLOT_IDS, type Slots } from "../../game/draft";
import { eventShortName, heroImage } from "../../game/data";
import type { DataBundle, Hero } from "../../game/types";
import { legalActions, type EngineState } from "../../mp/engine";
import { synergyHints } from "../../mp/synergy";
import type { Board, CardRef, ClientMsg, DraftPublic, RoomSnapshot } from "../../mp/protocol";
import { useNow } from "./useRoom";

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

/** Rebuild just enough EngineState for client-side legality display. */
function pseudoEngine(d: DraftPublic, numSeats: number): EngineState {
  return {
    numSeats,
    packSeq: d.packSeq,
    roundSeq: d.roundSeq,
    openerSeat: d.openerSeat,
    turnSeat: d.turnSeat,
    currentPacks: d.currentPacks,
    actedSeats: [],
    boards: d.boards,
    takenSteamIds: d.takenSteamIds,
    deniedShelf: d.deniedShelf,
    mulligansLeft: d.mulligansLeft,
    deniesLeft: d.deniesLeft,
    usedPackIds: [],
    done: false,
  };
}

function sameCard(a: CardRef, b: CardRef): boolean {
  return (
    (a.kind === "player" && b.kind === "player" && a.steamId === b.steamId) ||
    (a.kind === "hero" && b.kind === "hero" && a.heroId === b.heroId)
  );
}

function SynergyTag({
  steamId,
  myBoard,
  taken,
  bundle,
  nickById,
}: {
  steamId: number;
  myBoard: Board | null;
  taken: number[];
  bundle: DataBundle;
  nickById: Map<number, string>;
}) {
  const hints = useMemo(() => {
    const mine = myBoard
      ? SLOT_IDS.map((s) => myBoard.slots[s]).filter(Boolean).map((p) => p!.steamId)
      : [];
    return synergyHints(steamId, mine, taken, bundle.squadSynergy);
  }, [steamId, myBoard, taken, bundle]);

  const top = hints.withYours[0];
  if (top) {
    const names = top.partnerIds.map((id) => nickById.get(id) ?? `#${id}`).join("+");
    return (
      <span
        className="absolute right-1.5 top-2.5 z-10 rounded-sm border border-bone/40 bg-ink-950/85 px-1 py-0.5 text-[10px] font-bold text-bone"
        title={hints.withYours
          .map(
            (h) =>
              `${h.games}g with your ${h.partnerIds.map((id) => nickById.get(id) ?? id).join(" + ")} → +${h.bonus} OVR`,
          )
          .join("\n")}
      >
        +{top.bonus} c/ {names}
      </span>
    );
  }
  if (hints.bestUndrafted && hints.bestUndrafted.games >= 100) {
    const nick = nickById.get(hints.bestUndrafted.partnerId) ?? "?";
    return (
      <span
        className="absolute right-1.5 top-2.5 z-10 rounded-sm border border-ink-600 bg-ink-950/85 px-1 py-0.5 text-[10px] text-slate-mid"
        title={`${hints.bestUndrafted.games} games with ${nick}, who is still undrafted`}
      >
        {hints.bestUndrafted.games}g c/ {nick}
      </span>
    );
  }
  return null;
}

function MiniBoard({
  name,
  board,
  isMe,
  isTurn,
  isOpener,
  connected,
  mulligans,
  denies,
  heroById,
}: {
  name: string;
  board: Board;
  isMe: boolean;
  isTurn: boolean;
  isOpener: boolean;
  connected: boolean;
  mulligans: number;
  denies: number;
  heroById: Map<number, Hero>;
}) {
  return (
    <div
      className={`rounded-lg border p-2.5 ${
        isTurn
          ? "border-bone/60 bg-ink-800/80"
          : isMe
            ? "border-ink-600 bg-ink-900/60"
            : "border-ink-700 bg-ink-900/40"
      }`}
    >
      <div className="flex items-center gap-2">
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${connected ? "bg-bone" : "bg-ink-600"}`}
        />
        <span className={`min-w-0 flex-1 truncate text-sm font-bold ${isTurn ? "text-bone" : "text-slate-strong"}`}>
          {name}
          {isMe ? " (you)" : ""}
        </span>
        {isTurn && <span className="plate text-[10px] tracking-widest text-bone">picking…</span>}
        {!isTurn && isOpener && (
          <span className="plate text-[10px] tracking-widest text-slate-dim">opens</span>
        )}
      </div>
      <div className="mt-1.5 space-y-0.5">
        {SLOT_IDS.map((slotId) => {
          const p = (board.slots as Slots)[slotId];
          return (
            <div key={slotId} className="flex items-center gap-1.5 text-[11px]">
              <span className={`h-3 w-0.5 rounded ${p ? ROLE_BAR[p.role] : "bg-ink-700"}`} />
              {p ? (
                <>
                  <span className="min-w-0 flex-1 truncate text-slate-strong">{p.nickname}</span>
                  <span className={`font-mono font-bold ${ovrColor(p.ovr)}`}>{p.ovr}</span>
                </>
              ) : (
                <span className="flex-1 text-slate-dim">—</span>
              )}
            </div>
          );
        })}
      </div>
      <div className="mt-1.5 flex items-center gap-1">
        {board.heroes.map((h) => (
          <img
            key={h}
            src={heroImage(heroById.get(h)?.picture)}
            alt={heroById.get(h)?.name ?? ""}
            title={heroById.get(h)?.name}
            className="h-4 w-[27px] rounded-[2px] object-cover"
          />
        ))}
        {Array.from({ length: 5 - board.heroes.length }, (_, i) => (
          <span key={i} className="h-4 w-[27px] rounded-[2px] bg-ink-800" />
        ))}
        <span className="ml-auto text-[10px] tabular-nums text-slate-dim" title="mulligans · denies left">
          ↻{mulligans} ✕{denies}
        </span>
      </div>
    </div>
  );
}

export function DraftView({
  snapshot,
  mySeat,
  send,
  bundle,
  heroById,
}: {
  snapshot: RoomSnapshot;
  mySeat: number;
  send: (m: ClientMsg) => void;
  bundle: DataBundle;
  heroById: Map<number, Hero>;
}) {
  const d = snapshot.draft!;
  const seats = snapshot.seats;
  const eng = useMemo(() => pseudoEngine(d, seats.length), [d, seats.length]);
  const legal = useMemo(
    () =>
      mySeat >= 0
        ? legalActions(eng, mySeat)
        : { picks: [], canDeny: false, canPass: false, canMulligan: false },
    [eng, mySeat],
  );
  const myTurn = mySeat >= 0 && d.turnSeat === mySeat;
  const [denyArmed, setDenyArmed] = useState(false);
  useEffect(() => setDenyArmed(false), [d.packSeq, d.turnSeat]);

  const now = useNow(250);
  const secsLeft =
    d.turnDeadline != null ? Math.max(0, Math.ceil((d.turnDeadline - now) / 1000)) : null;

  const nickById = useMemo(() => {
    const m = new Map<number, string>();
    for (const pack of bundle.packs) for (const p of pack.players) m.set(p.steamId, p.nickname);
    return m;
  }, [bundle]);

  const turnName = d.turnSeat != null ? seats[d.turnSeat]?.name : null;
  const myBoard = mySeat >= 0 ? d.boards[mySeat] : null;

  const act = (card: CardRef) => {
    if (denyArmed) {
      send({ t: "deny", card });
      setDenyArmed(false);
    } else {
      send({ t: "pick", card });
    }
  };

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_300px]">
      <section>
        <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
          <div>
            <div className="plate text-sm tracking-widest text-slate-dim">
              Round #{d.roundSeq} — {seats[d.openerSeat]?.name} opens
              {d.currentPacks.length > 1 && " a double spread"}
            </div>
          </div>
          <div className="text-right">
            <div className={`text-sm font-bold ${myTurn ? "text-bone" : "text-slate-mid"}`}>
              {myTurn ? (denyArmed ? "DENY MODE — click any card to destroy it" : "Your pick") : `Waiting for ${turnName ?? "…"}`}
            </div>
            {secsLeft != null && d.turnSeat != null && (
              <div
                className={`font-mono text-2xl font-extrabold tabular-nums ${
                  secsLeft <= 10 ? "text-dire" : "text-slate-strong"
                }`}
              >
                0:{String(secsLeft).padStart(2, "0")}
              </div>
            )}
          </div>
        </div>

        <div key={`${d.roundSeq}`}>
          {d.currentPacks.map((pack, pi) => (
            <div key={pack.id} className={pi > 0 ? "mt-6" : ""}>
              <div className="mb-2 text-lg font-bold text-bone">
                {pack.teamName}
                <span className="ml-2 text-sm font-normal text-slate-dim">
                  {eventShortName(bundle, pack.eventId)}
                  {pack.placement != null && <> · finished {ordinal(pack.placement)}</>}
                </span>
              </div>
              <div className="flex flex-wrap gap-3">
                {pack.players.map((p, i) => {
                  const ref: CardRef = { kind: "player", steamId: p.steamId };
                  const pickable = legal.picks.some((c) => sameCard(c, ref));
                  const clickable = myTurn && (denyArmed ? legal.canDeny : pickable);
                  return (
                    <CardButton
                      key={p.steamId}
                      delay={pi * 0.25 + i * 0.06}
                      disabled={!clickable}
                      onPick={() => act(ref)}
                    >
                      <SynergyTag
                        steamId={p.steamId}
                        myBoard={myBoard}
                        taken={d.takenSteamIds}
                        bundle={bundle}
                        nickById={nickById}
                      />
                      <PlayerCardContent
                        p={p}
                        subtitle={
                          snapshot.config.cardMode === "event"
                            ? `${p.team} · ${eventShortName(bundle, p.eventId)}`
                            : p.team
                        }
                      />
                    </CardButton>
                  );
                })}
                {pack.heroes.map((h, i) => {
                  const ref: CardRef = { kind: "hero", heroId: h };
                  const pickable = legal.picks.some((c) => sameCard(c, ref));
                  const clickable = myTurn && (denyArmed ? legal.canDeny : pickable);
                  return (
                    <CardButton
                      key={h}
                      delay={pi * 0.25 + 0.3 + i * 0.06}
                      disabled={!clickable}
                      onPick={() => act(ref)}
                    >
                      <HeroCardContent hero={heroById.get(h)} />
                    </CardButton>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        {myTurn && (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {mySeat >= 0 && d.deniesLeft[mySeat] > 0 && (
              <button
                onClick={() => setDenyArmed((v) => !v)}
                disabled={!legal.canDeny}
                className={`rounded-lg border px-4 py-2 text-sm font-semibold transition ${
                  denyArmed
                    ? "border-dire bg-dire/15 text-dire"
                    : "border-ink-600 text-slate-strong hover:border-dire/60 hover:text-dire"
                } disabled:cursor-not-allowed disabled:opacity-40`}
                title="Destroy ANY card in the pack instead of picking — it's gone for everyone."
              >
                {denyArmed ? "✕ Deny armed — cancel" : `✕ Deny (${d.deniesLeft[mySeat]})`}
              </button>
            )}
            {legal.canPass && (
              <button
                onClick={() => send({ t: "pass" })}
                className="rounded-lg border border-ink-600 px-4 py-2 text-sm font-semibold text-slate-strong hover:border-slate-mid hover:text-bone"
              >
                Pass (nothing fits)
              </button>
            )}
            {legal.canMulligan && (
              <button
                onClick={() => send({ t: "mulligan" })}
                className="rounded-lg border border-ink-600 px-4 py-2 text-sm font-semibold text-slate-strong hover:border-slate-mid hover:text-bone"
                title="Burn this pack before anyone picks — everyone drafts from a replacement."
              >
                ↻ Mulligan pack ({mySeat >= 0 ? d.mulligansLeft[mySeat] : 0})
              </button>
            )}
          </div>
        )}

        {d.deniedShelf.length > 0 && (
          <div className="mt-5">
            <div className="plate mb-1.5 text-sm tracking-widest text-slate-dim">Denied shelf</div>
            <div className="flex flex-wrap gap-1.5">
              {d.deniedShelf.map((entry, i) => (
                <span
                  key={i}
                  className="rounded-sm border border-dire/40 bg-ink-900/60 px-2 py-0.5 text-[11px] text-slate-strong"
                  title={`denied by ${seats[entry.bySeat]?.name} on pack #${entry.packSeq}`}
                >
                  ✕{" "}
                  {entry.card.kind === "player"
                    ? entry.card.player.nickname
                    : heroById.get(entry.card.heroId)?.name}
                  <span className="ml-1 text-slate-dim">· {seats[entry.bySeat]?.name}</span>
                </span>
              ))}
            </div>
          </div>
        )}
      </section>

      <aside className="space-y-2">
        <div className="plate text-sm tracking-widest text-slate-dim">Boards</div>
        {seats.map((s, i) => (
          <MiniBoard
            key={s.playerId}
            name={s.name}
            board={d.boards[i]}
            isMe={i === mySeat}
            isTurn={d.turnSeat === i}
            isOpener={d.openerSeat === i}
            connected={s.connected}
            mulligans={d.mulligansLeft[i]}
            denies={d.deniesLeft[i]}
            heroById={heroById}
          />
        ))}
      </aside>
    </div>
  );
}
