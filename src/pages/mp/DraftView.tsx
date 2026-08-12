import { useEffect, useMemo, useRef, useState } from "react";
import { CardButton, HeroCardContent, PlayerCardContent, ROLE_BAR, ovrColor } from "../../components/cards";
import { HumanTeamBadge } from "../../components/HumanTeamBadge";
import { SLOT_IDS, type Slots } from "../../game/draft";
import { eventShortName, heroImage } from "../../game/data";
import { computeStrength, heroFitBonus } from "../../game/strength";
import type { DataBundle, Hero, RosterPlayer, TeamStrength } from "../../game/types";
import {
  activePackIndex,
  boardComplete,
  legalActions,
  packHolder,
  type Board,
  type CardRef,
} from "../../mp/engine";
import { NO_DRAFT_CUES, draftCues } from "../../mp/roomView";
import { synergyHints } from "../../mp/synergy";
import type { ClientMsg, RoomSnapshot } from "../../mp/protocol";
import { announce, preloadAnnouncer } from "./announcer";
import { ChatPanel } from "./ChatPanel";
import { SoundControl } from "./SoundControl";
import { TurnTimer } from "./TurnTimer";
import { useNow } from "./useRoom";

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
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
  strength,
  isMe,
  isTurn,
  isOpener,
  connected,
  mulligans,
  denies,
  heroById,
  queued = 0,
}: {
  name: string;
  board: Board;
  strength: TeamStrength;
  isMe: boolean;
  isTurn: boolean;
  isOpener: boolean;
  connected: boolean;
  mulligans: number;
  denies: number;
  heroById: Map<number, Hero>;
  /** Turbo: packs in this seat's hands (shown when more than one queues up). */
  queued?: number;
}) {
  const roster = SLOT_IDS.map((s) => (board.slots as Slots)[s]).filter(Boolean);
  const assignedHeroIds = new Set(
    strength.assignment.map((a) => a.heroId).filter((h): h is number => h != null),
  );
  const spareHeroes = board.heroes.filter((h) => !assignedHeroIds.has(h));
  return (
    <div
      className={`rounded-lg border p-2.5 transition-colors ${
        isTurn
          ? "border-bone/60 bg-ink-800/80 shadow-[0_0_16px_rgba(233,229,218,0.07)]"
          : isMe
            ? "border-ink-600 bg-ink-900/60"
            : "border-ink-700 bg-ink-900/40"
      }`}
    >
      <div className="flex items-center gap-2">
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${connected ? "bg-bone" : "bg-ink-600"}`}
        />
        <span
          className={`min-w-0 flex-1 truncate text-sm font-bold ${
            isTurn ? "text-bone" : "text-slate-strong"
          }`}
        >
          {name}
        </span>
        {isMe && <HumanTeamBadge self />}
        {isTurn && (
          <span className="plate text-[10px] tracking-widest text-bone">
            picking…{queued > 1 ? ` +${queued - 1}` : ""}
          </span>
        )}
        {!isTurn && isOpener && (
          <span className="plate text-[10px] tracking-widest text-slate-dim">opens</span>
        )}
        <span
          className={`font-mono text-sm font-extrabold ${roster.length ? ovrColor(strength.overall) : "text-slate-dim"}`}
          title={`${strength.base} base + ${strength.heroBonus} hero fit + ${strength.chemBonus} chemistry`}
        >
          {roster.length ? strength.overall : "—"}
        </span>
      </div>
      <div className="mt-1.5 space-y-0.5">
        {SLOT_IDS.map((slotId) => {
          const p = (board.slots as Slots)[slotId];
          const rosterIdx = p ? roster.indexOf(p) : -1;
          const assigned = rosterIdx >= 0 ? strength.assignment[rosterIdx] : null;
          const hero = assigned?.heroId != null ? heroById.get(assigned.heroId) : undefined;
          const fit = assigned ? heroFitBonus(assigned.games) : 0;
          return (
            <div key={slotId} className="flex items-center gap-1.5 text-[11px]">
              <span className={`h-3 w-0.5 rounded ${p ? ROLE_BAR[p.role] : "bg-ink-700"}`} />
              {p ? (
                <>
                  <span className="min-w-0 flex-1 truncate text-slate-strong">{p.nickname}</span>
                  {hero && (
                    <span
                      className="flex shrink-0 items-center gap-1"
                      title={`${p.nickname}: ${assigned?.games ?? 0}g on ${hero.name} → +${fit} team OVR`}
                    >
                      <img
                        src={heroImage(hero.picture)}
                        alt={hero.name}
                        className="h-3.5 w-6 rounded-[2px] object-cover"
                      />
                      <span
                        className={`font-mono text-[10px] tabular-nums ${fit > 0 ? "text-slate-strong" : "text-slate-dim"}`}
                      >
                        +{fit}
                      </span>
                    </span>
                  )}
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
        {spareHeroes.map((h) => (
          <img
            key={h}
            src={heroImage(heroById.get(h)?.picture)}
            alt={heroById.get(h)?.name ?? ""}
            title={`${heroById.get(h)?.name} — unassigned`}
            className="h-4 w-[27px] rounded-[2px] object-cover opacity-70"
          />
        ))}
        {Array.from({ length: 5 - board.heroes.length }, (_, i) => (
          <span key={i} className="h-4 w-[27px] rounded-[2px] bg-ink-800" />
        ))}
        <span className="ml-auto text-[10px] tabular-nums text-slate-dim" title="mulligans · denies left">
          ↻{mulligans} ✕{denies}
        </span>
      </div>
      {roster.length > 0 && (
        <div className="mt-1.5 flex items-center gap-2 border-t border-ink-800 pt-1.5 font-mono text-[10px] tabular-nums text-slate-dim">
          <span title="average OVR of drafted players">{strength.base} base</span>
          <span title="games played on assigned heroes">+{strength.heroBonus} fit</span>
          <span title="games played together as teammates">+{strength.chemBonus} chem</span>
        </div>
      )}
      {strength.chemTop.length > 0 && (
        <div className="mt-1 space-y-0.5">
          {strength.chemTop.slice(0, 2).map((c, i) => (
            <div
              key={i}
              className="flex items-center justify-between text-[10px]"
              title={`${c.games} games played together → +${c.bonus} team OVR`}
            >
              <span className="min-w-0 truncate text-slate-mid">{c.names.join(" + ")}</span>
              <span className="ml-1.5 shrink-0 tabular-nums text-slate-dim">
                {c.games}g<span className="ml-1 font-mono font-bold text-slate-strong">+{c.bonus}</span>
              </span>
            </div>
          ))}
        </div>
      )}
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
  const turbo = d.mode === "turbo";
  const legal = useMemo(
    () =>
      mySeat >= 0
        ? legalActions(d, mySeat)
        : { picks: [], canDeny: false, canPass: false, canMulligan: false },
    [d, mySeat],
  );
  // Turbo: my "turn" is the pack in my hands (packs queue behind it while
  // I think); classic: the one shared turn seat.
  const myPackIdx = turbo && mySeat >= 0 ? activePackIndex(d, mySeat) : -1;
  const myTurn = mySeat >= 0 && (turbo ? myPackIdx >= 0 : d.turnSeat === mySeat);
  const myPackKey =
    turbo && myPackIdx >= 0 ? `${d.roundSeq}:${d.currentPacks[myPackIdx].id}` : null;
  const heldBySeat = useMemo(
    () =>
      seats.map((_, i) =>
        turbo ? d.currentPacks.filter((_, pi) => packHolder(d, pi) === i).length : 0,
      ),
    [turbo, d, seats],
  );
  const [denyArmed, setDenyArmed] = useState(false);
  useEffect(() => setDenyArmed(false), [d.packSeq, d.turnSeat, myPackKey]);

  const now = useNow(250);
  // Turbo has no shared clock — only my own pack's deadline matters to me.
  const myDeadline = turbo
    ? mySeat >= 0
      ? (d.turnDeadlines?.[mySeat] ?? null)
      : null
    : d.turnDeadline;
  const secsLeft =
    myDeadline != null ? Math.max(0, Math.ceil((myDeadline - now) / 1000)) : null;

  // Dota announcer. WHEN to speak is pure (draftCues in src/mp/roomView.ts);
  // this effect just plays what it says, on every render — the cue state
  // keeps repeats silent.
  useEffect(preloadAnnouncer, []);
  const cueState = useRef(NO_DRAFT_CUES);
  useEffect(() => {
    const r = draftCues(cueState.current, {
      myTurn,
      roundSeq: d.roundSeq,
      turnSeat: d.turnSeat,
      secsLeft,
      turnKey: myPackKey ?? undefined,
    });
    cueState.current = r.state;
    r.announce.forEach(announce);
  });

  const nickById = useMemo(() => {
    const m = new Map<number, string>();
    for (const pack of bundle.packs) for (const p of pack.players) m.set(p.steamId, p.nickname);
    return m;
  }, [bundle]);

  const turnName = d.turnSeat != null ? seats[d.turnSeat]?.name : null;
  const myBoard = mySeat >= 0 ? d.boards[mySeat] : null;

  const strengths = useMemo(
    () =>
      d.boards.map((b) => {
        const roster = SLOT_IDS.map((s) => (b.slots as Slots)[s]).filter(
          (p): p is RosterPlayer => p != null,
        );
        return computeStrength(roster, b.heroes, bundle.playerHeroStats, bundle.squadSynergy, null);
      }),
    [d.boards, bundle],
  );

  // Turbo: a seated drafter acts only on the pack in their hands; spectators
  // (and classic tables) see every open pack.
  const shownPacks =
    turbo && mySeat >= 0 ? (myPackIdx >= 0 ? [myPackIdx] : []) : d.currentPacks.map((_, i) => i);

  const act = (card: CardRef) => {
    if (denyArmed) {
      send({ t: "draft", action: { type: "deny", card } });
      setDenyArmed(false);
    } else {
      send({ t: "draft", action: { type: "pick", card } });
    }
  };

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_300px]">
      {myTurn && myDeadline != null && snapshot.config.timerSecs != null && (
        <TurnTimer deadline={myDeadline} totalSecs={snapshot.config.timerSecs} />
      )}
      <section>
        <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
          <div>
            <div className="plate text-sm tracking-widest text-slate-dim">
              {turbo ? (
                <>Wave #{d.roundSeq} — everyone picks at once</>
              ) : (
                <>
                  Round #{d.roundSeq} — {seats[d.openerSeat]?.name} opens
                  {d.currentPacks.length > 1 && " a double spread"}
                </>
              )}
            </div>
          </div>
          <div className="text-right">
            <div
              className={`flex items-center justify-end gap-2 text-sm font-bold ${
                myTurn ? (denyArmed ? "text-dire" : "text-bone") : "text-slate-mid"
              }`}
            >
              {myTurn && !denyArmed && <span className="live-dot" />}
              {myTurn
                ? denyArmed
                  ? "DENY MODE — click any card to destroy it"
                  : "Your pick"
                : turbo
                  ? mySeat >= 0
                    ? "Waiting for the chain…"
                    : "Spectating the chain"
                  : `Waiting for ${turnName ?? "…"}`}
            </div>
            {secsLeft != null && (turbo ? myTurn : d.turnSeat != null) && (
              <div
                className={`font-mono text-2xl font-extrabold tabular-nums ${
                  secsLeft <= 10 ? "anim-urgent text-dire" : "text-slate-strong"
                }`}
              >
                0:{String(secsLeft).padStart(2, "0")}
              </div>
            )}
          </div>
        </div>

        <div key={`${d.roundSeq}`}>
          {shownPacks.map((packIdx, order) => {
            const pack = d.currentPacks[packIdx];
            // In turbo only the pack in my hands is actionable; spectators act on nothing.
            const actionable = turbo ? myTurn && packIdx === myPackIdx : myTurn;
            return (
              <div key={pack.id} className={order > 0 ? "mt-6" : ""}>
                <div className="mb-2 text-lg font-bold text-bone">
                  {pack.teamName}
                  <span className="ml-2 text-sm font-normal text-slate-dim">
                    {eventShortName(bundle, pack.eventId)}
                    {pack.placement != null && <> · finished {ordinal(pack.placement)}</>}
                    {turbo && mySeat < 0 && (
                      <> · en manos de {seats[packHolder(d, packIdx)]?.name}</>
                    )}
                    {turbo && mySeat >= 0 && heldBySeat[mySeat] > 1 && (
                      <> · +{heldBySeat[mySeat] - 1} en cola</>
                    )}
                  </span>
                </div>
                <div className="flex flex-wrap gap-3">
                  {pack.players.map((p, i) => {
                    const ref: CardRef = { kind: "player", steamId: p.steamId };
                    const pickable = legal.picks.some((c) => sameCard(c, ref));
                    const clickable = actionable && (denyArmed ? legal.canDeny : pickable);
                    return (
                      <CardButton
                        key={p.steamId}
                        delay={order * 0.25 + i * 0.06}
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
                    const clickable = actionable && (denyArmed ? legal.canDeny : pickable);
                    return (
                      <CardButton
                        key={h}
                        delay={order * 0.25 + 0.3 + i * 0.06}
                        disabled={!clickable}
                        onPick={() => act(ref)}
                      >
                        <HeroCardContent hero={heroById.get(h)} />
                      </CardButton>
                    );
                  })}
                </div>
              </div>
            );
          })}
          {turbo && mySeat >= 0 && myPackIdx < 0 && (
            <div className="rounded-xl border border-dashed border-ink-700 bg-ink-900/30 px-4 py-10 text-center text-sm text-slate-mid">
              {myBoard && boardComplete(myBoard)
                ? "Tu board está completo — esperando a que terminen los demás…"
                : "Sin pack en mano — la cadena se mueve cuando los demás pickean."}
            </div>
          )}
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
                onClick={() => send({ t: "draft", action: { type: "pass" } })}
                className="rounded-lg border border-ink-600 px-4 py-2 text-sm font-semibold text-slate-strong hover:border-slate-mid hover:text-bone"
              >
                Pass (nothing fits)
              </button>
            )}
            {legal.canMulligan && (
              <button
                onClick={() => send({ t: "draft", action: { type: "mulligan" } })}
                className="rounded-lg border border-ink-600 px-4 py-2 text-sm font-semibold text-slate-strong hover:border-slate-mid hover:text-bone"
                title={
                  turbo
                    ? "Burn this freshly dealt pack — you draft from a replacement."
                    : "Burn this pack before anyone picks — everyone drafts from a replacement."
                }
              >
                ↻ Mulligan pack ({mySeat >= 0 ? d.mulligansLeft[mySeat] : 0})
              </button>
            )}
          </div>
        )}

        {turbo && d.currentPacks.length > 0 && (
          <div className="mt-5">
            <div className="plate mb-1.5 text-sm tracking-widest text-slate-dim">La cadena</div>
            <div className="flex flex-wrap gap-1.5">
              {d.currentPacks.map((p, i) => {
                const holder = packHolder(d, i);
                const isMine = mySeat >= 0 && holder === mySeat;
                return (
                  <span
                    key={p.id}
                    className={`flex items-center gap-1 rounded-sm border px-2 py-0.5 text-[11px] ${
                      isMine
                        ? "border-bone/50 bg-ink-800/70 text-bone"
                        : "border-ink-600 bg-ink-900/60 text-slate-mid"
                    }`}
                    title={`opened by ${seats[d.packDealtTo[i]]?.name} · ${
                      p.players.length + p.heroes.length
                    } cards left`}
                  >
                    {p.teamName}
                    <span className="text-slate-dim">· {seats[holder]?.name}</span>
                    {isMine && <HumanTeamBadge self />}
                  </span>
                );
              })}
            </div>
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
        <div className="flex items-center justify-between">
          <div className="plate text-sm tracking-widest text-slate-dim">Boards</div>
          <SoundControl />
        </div>
        {seats.map((s, i) => (
          <MiniBoard
            key={s.playerId}
            name={s.name}
            board={d.boards[i]}
            strength={strengths[i]}
            isMe={i === mySeat}
            isTurn={turbo ? heldBySeat[i] > 0 : d.turnSeat === i}
            isOpener={!turbo && d.openerSeat === i}
            connected={s.connected}
            mulligans={d.mulligansLeft[i]}
            denies={d.deniesLeft[i]}
            heroById={heroById}
            queued={heldBySeat[i]}
          />
        ))}
        <ChatPanel
          chat={snapshot.chat ?? []}
          myId={mySeat >= 0 ? seats[mySeat].playerId : null}
          canChat={mySeat >= 0}
          send={send}
          docked
        />
      </aside>
    </div>
  );
}
