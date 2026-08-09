import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Broadcast } from "../components/Broadcast";
import { DEV_TAUNT_ALL } from "../game/beats";
import { CardButton, HeroCardContent, PlayerCardContent } from "../components/cards";
import { DraftRecap } from "../components/DraftRecap";
import { RosterBoard } from "../components/RosterBoard";
import { Stinger } from "../components/Stinger";
import { buildCardPool } from "../game/cards";
import { eventShortName, useBundle, useHeroById } from "../game/data";
import { SLOT_IDS, canPickHero, canPickPlayer, isComplete, pickedIds } from "../game/draft";
import { FIELD_REROLL_EXCUSES, fieldRank, generateField } from "../game/field";
import { luckTraitFor } from "../game/luck";
import { randomSeed } from "../game/rng";
import { simulateTournament } from "../game/sim";
import { useRunStore } from "../game/store";
import { computeStrength, swapHeroAssignment } from "../game/strength";
import type { RosterPlayer } from "../game/types";

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

function ManualAssign({
  roster,
  heroes,
  heroAssign,
  onSwap,
}: {
  roster: RosterPlayer[];
  heroes: number[];
  heroAssign: Record<string, number>;
  onSwap: (steamId: string, heroId: number) => void;
}) {
  const heroById = useHeroById(useBundle().bundle);
  return (
    <div className="panel mt-4 rounded-xl p-4">
      <div className="plate mb-2 text-sm tracking-widest text-slate-dim">
        Hero Assignment (manual)
      </div>
      <div className="space-y-1.5">
        {roster.map((p) => (
          <div key={p.steamId} className="flex items-center gap-3">
            <span className="w-28 truncate text-sm font-semibold text-slate-strong">
              {p.nickname}
            </span>
            <select
              value={heroAssign[String(p.steamId)] ?? ""}
              onChange={(e) => onSwap(String(p.steamId), Number(e.target.value))}
              className="rounded border border-ink-600 bg-ink-900 px-2 py-1 text-sm text-slate-strong"
            >
              {heroes.map((h) => (
                <option key={h} value={h}>
                  {heroById.get(h)?.name ?? h}
                </option>
              ))}
            </select>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Draft() {
  const navigate = useNavigate();
  const { bundle, error } = useBundle();
  const heroById = useHeroById(bundle);
  const {
    config,
    active,
    pendingStart,
    setPendingStart,
    startRun,
    slots,
    heroes,
    current,
    rerollsLeft,
    reroll,
    pickPlayer,
    pickHero,
    teamName,
    fieldSeed,
    setFieldSeed,
    simSeed,
    setSimSeed,
    heroAssign,
    setHeroAssign,
    recordRun,
    resetRun,
  } = useRunStore();

  const pool = useMemo(
    () => (bundle ? buildCardPool(bundle, config.format, config.cardMode).packs : []),
    [bundle, config.format, config.cardMode],
  );

  // Opening stinger for a fresh run — the first pack deals in as it fades.
  const [stinger, setStinger] = useState(false);

  useEffect(() => {
    if (!bundle || !pool.length) return;
    if (active) return;
    if (pendingStart) {
      setPendingStart(false);
      startRun(pool);
      setStinger(true);
      return;
    }
    navigate("/solo");
  }, [bundle, pool, active, pendingStart, setPendingStart, startRun, navigate]);

  const roster = useMemo(
    () => SLOT_IDS.map((s) => slots[s]).filter((p): p is RosterPlayer => Boolean(p)),
    [slots],
  );
  const manual = config.heroAlloc === "manual";
  const complete = isComplete(slots, heroes);

  const strength = useMemo(
    () =>
      computeStrength(
        roster,
        heroes,
        bundle?.playerHeroStats ?? {},
        bundle?.squadSynergy ?? [],
        manual ? heroAssign : null,
      ),
    [roster, heroes, bundle, manual, heroAssign],
  );

  // Seed the manual assignment from the auto-optimal one when the draft completes.
  useEffect(() => {
    if (!bundle || !manual || !complete || Object.keys(heroAssign).length) return;
    const auto = computeStrength(roster, heroes, bundle.playerHeroStats, bundle.squadSynergy, null);
    const next: Record<string, number> = {};
    roster.forEach((p, i) => {
      const heroId = auto.assignment[i]?.heroId;
      if (heroId != null) next[String(p.steamId)] = heroId;
    });
    setHeroAssign(next);
  }, [bundle, manual, complete, heroAssign, roster, heroes, setHeroAssign]);

  const luck = useMemo(() => luckTraitFor(roster), [roster]);
  const field = useMemo(
    () => generateField(strength.overall, teamName || "Your Team", fieldSeed, luck),
    [strength.overall, teamName, fieldSeed, luck],
  );
  const result = useMemo(
    () => (simSeed != null ? simulateTournament(field, simSeed) : null),
    [field, simSeed],
  );
  const rank = useMemo(() => fieldRank(field), [field]);
  const excuse = FIELD_REROLL_EXCUSES[fieldSeed % FIELD_REROLL_EXCUSES.length];

  if (error) return <div className="text-dire">Failed to load data: {error}</div>;
  if (!bundle || !active) return <div className="text-slate-500">Loading draft…</div>;

  const picked = pickedIds(slots);

  const swapHero = (steamId: string, heroId: number) => {
    setHeroAssign(swapHeroAssignment(heroAssign, steamId, heroId));
  };

  const simulate = () => {
    const seed = randomSeed();
    const res = simulateTournament(field, seed);
    setSimSeed(seed);
    recordRun({
      id: seed,
      date: Date.now(),
      place: res.userPlace,
      label: res.userLabel,
      overall: strength.overall,
      undefeated: res.userUndefeated,
      flawlessGroup: res.flawlessGroup,
      gamesWon: res.gamesWon,
      gamesLost: res.gamesLost,
      champion: res.champion.name,
      config: { ...config },
      roster: roster.map((p, i) => ({
        nickname: p.nickname,
        steamId: p.steamId,
        role: p.role,
        ovr: p.ovr,
        heroId: strength.assignment[i]?.heroId ?? null,
      })),
    });
  };

  const newRun = () => {
    resetRun();
    navigate("/solo");
  };

  if (result) {
    // Dev preview: solo taunts on every series you win, using your saved
    // phrases (or stand-ins) — lets the animation be tested without a lobby.
    const devPhrases = DEV_TAUNT_ALL
      ? useRunStore.getState().winPhrases.length
        ? useRunStore.getState().winPhrases
        : ["EZ GAME EZ LIFE", "gg no re", "¿Eso es todo?"]
      : undefined;
    return (
      <Broadcast
        key={result.seed}
        result={result}
        teamName={teamName || "Your Team"}
        localTauntPhrases={devPhrases}
        footer={
          <div className="space-y-4">
            <div className="panel rounded-xl p-4">
              <div className="plate mb-2 text-sm tracking-widest text-slate-dim">
                Your Draft
              </div>
              <DraftRecap
                slots={slots}
                heroes={heroes}
                strength={strength}
                heroById={heroById}
              />
            </div>
            <div className="flex gap-3">
              <button
                onClick={simulate}
                className="flex-1 rounded-lg border border-ink-600 py-3 text-sm font-semibold text-slate-strong hover:border-slate-mid hover:text-bone"
              >
                Run it back (new bracket)
              </button>
              <button
                onClick={newRun}
                className="cta-dota plate flex-1 rounded-lg py-3 text-base font-bold tracking-widest"
              >
                New draft
              </button>
            </div>
          </div>
        }
      />
    );
  }

  return (
    <div className="grid grid-cols-1 gap-8 lg:grid-cols-[2fr_3fr]">
      {stinger && (
        <Stinger
          eyebrow="El Copero del Dota"
          title={teamName || "Your Team"}
          sub="5 pros · 5 héroes · un Aegis"
          onDone={() => setStinger(false)}
        />
      )}
      <section>
        <RosterBoard slots={slots} heroes={heroes} strength={strength} heroById={heroById} />
        {manual && complete && (
          <ManualAssign
            roster={roster}
            heroes={heroes}
            heroAssign={heroAssign}
            onSwap={swapHero}
          />
        )}
      </section>

      <section>
        {!complete && current && !stinger && (
          <div>
            <div className="mb-4 flex items-end justify-between gap-3">
              {/* pack banner — slams in with every fresh pack */}
              <div key={current.id} className="anim-slam-l min-w-0">
                <div className="plate text-xs tracking-[0.3em] text-slate-dim">
                  Pack — pick one card
                </div>
                <div className="angled-l mt-1 inline-flex max-w-full items-baseline gap-2 border-l-2 border-trophy-dim bg-ink-800/90 py-1.5 pl-3 pr-6">
                  <span className="plate-italic truncate text-xl leading-none text-bone sm:text-2xl">
                    {current.teamName}
                  </span>
                  <span className="shrink-0 text-xs text-slate-mid">
                    {eventShortName(bundle, current.eventId)}
                    {current.placement != null && <> · finished {ordinal(current.placement)}</>}
                  </span>
                </div>
              </div>
              <button
                onClick={() => reroll(pool)}
                disabled={rerollsLeft <= 0}
                className={`shrink-0 rounded-lg border px-4 py-2 text-sm font-semibold transition ${
                  rerollsLeft > 0
                    ? "border-ink-600 text-slate-strong hover:border-slate-mid hover:text-bone"
                    : "cursor-not-allowed border-ink-700 text-slate-dim"
                }`}
              >
                Reroll pack ({rerollsLeft})
              </button>
            </div>

            <div className="flex flex-wrap gap-3" key={current.id}>
              {current.players.map((p, i) => (
                <CardButton
                  key={p.steamId}
                  delay={i * 0.06}
                  disabled={!canPickPlayer(p, slots, picked)}
                  onPick={() => pickPlayer(pool, p)}
                >
                  <PlayerCardContent
                    p={p}
                    subtitle={
                      config.cardMode === "event"
                        ? `${p.team} · ${eventShortName(bundle, p.eventId)}`
                        : p.team
                    }
                  />
                </CardButton>
              ))}
              {current.heroes.map((h, i) => (
                <CardButton
                  key={h}
                  delay={0.3 + i * 0.06}
                  disabled={!canPickHero(h, heroes)}
                  onPick={() => pickHero(pool, h)}
                >
                  <HeroCardContent hero={heroById.get(h)} />
                </CardButton>
              ))}
            </div>
            <div className="mt-3 text-xs text-slate-dim">
              {5 - roster.length} player slot{5 - roster.length === 1 ? "" : "s"} ·{" "}
              {5 - heroes.length} hero slot{5 - heroes.length === 1 ? "" : "s"} remaining
            </div>
          </div>
        )}

        {complete && !result && (
          <div className="panel beat-in rounded-xl p-5">
            <div className="plate text-sm tracking-widest text-slate-dim">
              The International — Field of 18
            </div>
            <div className="mt-2 text-slate-strong">
              Your team rates <span className="font-mono font-bold text-bone">{strength.overall}</span>{" "}
              — projected seed{" "}
              <span className="font-mono font-bold text-bone">
                #{rank.low}–{rank.high}
              </span>{" "}
              of 18.
            </div>
            <div className="mt-3 max-h-56 overflow-y-auto rounded bg-ink-800/50 p-2 text-sm">
              {[...field]
                .sort((a, b) => b.strength - a.strength)
                .map((t) => (
                  <div
                    key={t.id}
                    className={`flex justify-between py-0.5 ${t.isUser ? "font-bold text-bone" : "text-slate-mid"}`}
                  >
                    <span>{t.name}</span>
                    <span className="font-mono text-xs">{t.isUser ? "?" : t.strength}</span>
                  </div>
                ))}
            </div>
            <div className="mt-4 flex gap-3">
              <button
                onClick={simulate}
                className="cta-dota cta-pulse plate flex-1 rounded-lg py-3 text-lg font-bold tracking-widest"
              >
                Play The International
              </button>
              <button
                onClick={() => setFieldSeed(randomSeed())}
                title={`Somebody dropped out: ${excuse}`}
                className="rounded-lg border border-ink-600 px-4 py-3 text-sm text-slate-mid hover:border-slate-mid hover:text-bone"
              >
                Reroll field
              </button>
            </div>
            <div className="mt-2 text-center text-[11px] italic text-slate-dim">
              latest field drama: {excuse}
            </div>
          </div>
        )}

      </section>
    </div>
  );
}
