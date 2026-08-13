// ---------------------------------------------------------------------------
// The ranked rating module — pure math, no I/O. Pairwise Elo over the humans'
// relative finishing order (docs/RANKED.md): the match is scored as one duel
// against every other human, so a strong player in a weak lobby has little to
// gain and much to lose. AI teams and absolute tournament placement stay out
// of the exchange, with one deliberate exception: winning the whole
// International pays a flat bonus outside the zero-sum pool.
//
// The server-authoritative ranked room is the only caller that writes these
// numbers anywhere; everything here is deterministic from its inputs.
// ---------------------------------------------------------------------------

/** Ranked matches never form below this — the queue enforces it. */
export const RANKED_MIN_PLAYERS = 4;

export const STARTING_RATING = 1000;
export const ELO_DIVISOR = 400;
/** Games before a rating is considered settled and K drops. */
export const PLACEMENT_GAMES = 10;
export const K_PLACEMENT = 64;
export const K_SETTLED = 32;
export const TI_CHAMPION_BONUS = 15;
export const RATING_FLOOR = 0;

export interface RatedPlayer {
  userId: string;
  /** Rating going into this match. */
  rating: number;
  /** Ranked games completed before this one — selects K. */
  gamesPlayed: number;
  /** Tournament placement from the sim (shared placements allowed). */
  place: number;
  /** Breaks shared placements, as the standings table already does. */
  gamesWon: number;
}

export interface RatingChange {
  userId: string;
  before: number;
  /** The pairwise Elo delta, rounded. Zero-sum across the room when every
   *  player shares a K; mixed placement/settled K's deviate slightly. */
  exchange: number;
  /** TI-champion bonus — the one non-zero-sum element. */
  bonus: number;
  /** before + exchange + bonus, clamped at RATING_FLOOR. */
  after: number;
}

export function kFor(gamesPlayed: number): number {
  return gamesPlayed < PLACEMENT_GAMES ? K_PLACEMENT : K_SETTLED;
}

/** Expected score of `a` against `b` — the standard Elo curve. */
export function expectedScore(a: number, b: number): number {
  return 1 / (1 + 10 ** ((b - a) / ELO_DIVISOR));
}

/** 1 if `a` finished above `b`, 0 below, 0.5 on a residual tie. The order is
 *  the standings table's: placement first, then games won. */
function score(a: RatedPlayer, b: RatedPlayer): number {
  if (a.place !== b.place) return a.place < b.place ? 1 : 0;
  if (a.gamesWon !== b.gamesWon) return a.gamesWon > b.gamesWon ? 1 : 0;
  return 0.5;
}

/**
 * Rate one completed match. Order of the input doesn't matter; every player
 * is scored against every other, and the per-pair sum is scaled by K/(n−1)
 * so the total swing of a match doesn't grow with the room size.
 */
export function rateMatch(players: RatedPlayer[]): RatingChange[] {
  if (players.length < 2) throw new Error("rateMatch needs at least two players");
  const seen = new Set(players.map((p) => p.userId));
  if (seen.size !== players.length) throw new Error("rateMatch: duplicate userId");

  return players.map((me) => {
    let sum = 0;
    for (const other of players) {
      if (other.userId === me.userId) continue;
      sum += score(me, other) - expectedScore(me.rating, other.rating);
    }
    const exchange = Math.round((kFor(me.gamesPlayed) / (players.length - 1)) * sum);
    const bonus = me.place === 1 ? TI_CHAMPION_BONUS : 0;
    return {
      userId: me.userId,
      before: me.rating,
      exchange,
      bonus,
      after: Math.max(RATING_FLOOR, me.rating + exchange + bonus),
    };
  });
}
