import type { CardMode, DataBundle, EventInfo, GameFormat, Pack, PackPlayer, Role } from "./types";

// ---------------------------------------------------------------------------
// Card building. The original game has one card per player PER EVENT (a
// player who attended 8 TIs exists as 8 different cards). We additionally
// support two deduplicated modes:
//   career — one card per player, stats averaged over all their events,
//            weighted by games played at each event.
//   peak   — one card per player, rated by their best event blended with the
//            events immediately before/after it (weights 1-2-1) to smooth
//            one-tournament wonders.
// In deduped modes packs keep their identity (a team at an event, with its
// signature heroes) but every player row is replaced by the player's single
// deduped card, so the same pro shows identical stats wherever they appear.
// ---------------------------------------------------------------------------

interface PlayerInstance {
  player: PackPlayer;
  teamName: string;
  eventId: string;
  eventOrder: number; // chronological order index
}

function eventOrderMap(events: EventInfo[]): Map<string, number> {
  const sorted = [...events].sort((a, b) => a.year - b.year || a.id.localeCompare(b.id));
  return new Map(sorted.map((e, i) => [e.id, i]));
}

export function packsForFormat(bundle: DataBundle, format: GameFormat): Pack[] {
  const eventIds = new Set(
    bundle.events.filter((e) => (e.formats ?? []).includes(format)).map((e) => e.id),
  );
  const filtered = bundle.packs.filter((p) => eventIds.has(p.eventId));
  return filtered.length ? filtered : bundle.packs;
}

function roundStat(v: number): number {
  return Math.round(v);
}

function weightedRole(instances: { role: Role; games: number }[]): Role {
  const acc = new Map<Role, number>();
  for (const i of instances) acc.set(i.role, (acc.get(i.role) ?? 0) + Math.max(1, i.games));
  let best: Role = instances[instances.length - 1].role;
  let bestGames = -1;
  for (const [role, games] of acc) {
    if (games > bestGames) {
      best = role;
      bestGames = games;
    }
  }
  return best;
}

function collectInstances(packs: Pack[], events: EventInfo[]): Map<number, PlayerInstance[]> {
  const order = eventOrderMap(events);
  const byPlayer = new Map<number, PlayerInstance[]>();
  for (const pack of packs) {
    for (const player of pack.players) {
      const list = byPlayer.get(player.steamId) ?? [];
      list.push({
        player,
        teamName: pack.teamName,
        eventId: pack.eventId,
        eventOrder: order.get(pack.eventId) ?? 0,
      });
      byPlayer.set(player.steamId, list);
    }
  }
  for (const list of byPlayer.values()) list.sort((a, b) => a.eventOrder - b.eventOrder);
  return byPlayer;
}

function careerCard(instances: PlayerInstance[]): PackPlayer & { team: string } {
  const totalGames = instances.reduce((s, i) => s + Math.max(1, i.player.games), 0);
  const avg = (get: (p: PackPlayer) => number) =>
    roundStat(
      instances.reduce((s, i) => s + get(i.player) * Math.max(1, i.player.games), 0) / totalGames,
    );
  const latest = instances[instances.length - 1];
  return {
    steamId: latest.player.steamId,
    nickname: latest.player.nickname,
    role: weightedRole(instances.map((i) => ({ role: i.player.role, games: i.player.games }))),
    ovr: avg((p) => p.ovr),
    impact: avg((p) => p.impact),
    economy: avg((p) => p.economy),
    reliability: avg((p) => p.reliability),
    games: instances.reduce((s, i) => s + i.player.games, 0),
    team: latest.teamName,
  };
}

function peakCard(instances: PlayerInstance[]): PackPlayer & { team: string } {
  let peakIdx = 0;
  for (let i = 1; i < instances.length; i++) {
    if (instances[i].player.ovr > instances[peakIdx].player.ovr) peakIdx = i;
  }
  // Blend the peak event with its chronological neighbours, weights 1-2-1.
  const window: { inst: PlayerInstance; w: number }[] = [{ inst: instances[peakIdx], w: 2 }];
  if (peakIdx > 0) window.push({ inst: instances[peakIdx - 1], w: 1 });
  if (peakIdx < instances.length - 1) window.push({ inst: instances[peakIdx + 1], w: 1 });
  const totalW = window.reduce((s, x) => s + x.w, 0);
  const blend = (get: (p: PackPlayer) => number) =>
    roundStat(window.reduce((s, x) => s + get(x.inst.player) * x.w, 0) / totalW);
  const peak = instances[peakIdx];
  return {
    steamId: peak.player.steamId,
    nickname: peak.player.nickname,
    role: peak.player.role,
    ovr: blend((p) => p.ovr),
    impact: blend((p) => p.impact),
    economy: blend((p) => p.economy),
    reliability: blend((p) => p.reliability),
    games: peak.player.games,
    team: peak.teamName,
  };
}

export interface CardPool {
  packs: Pack[];
  /** In deduped modes, the card a steamId resolves to; empty for "event" mode. */
  cardTeam: Map<number, string>;
}

/**
 * Build the draftable pack pool for a config. In deduped modes each pack's
 * player rows are replaced with the player's single card.
 */
export function buildCardPool(bundle: DataBundle, format: GameFormat, mode: CardMode): CardPool {
  const packs = packsForFormat(bundle, format);
  if (mode === "event") return { packs, cardTeam: new Map() };

  const byPlayer = collectInstances(packs, bundle.events);
  const cards = new Map<number, PackPlayer & { team: string }>();
  for (const [steamId, instances] of byPlayer) {
    cards.set(steamId, mode === "career" ? careerCard(instances) : peakCard(instances));
  }

  const cardTeam = new Map<number, string>();
  for (const [steamId, card] of cards) cardTeam.set(steamId, card.team);

  const dedupedPacks = packs.map((pack) => ({
    ...pack,
    players: pack.players.map((p) => {
      const card = cards.get(p.steamId)!;
      const { team: _team, ...rest } = card;
      return rest;
    }),
  }));
  return { packs: dedupedPacks, cardTeam };
}
