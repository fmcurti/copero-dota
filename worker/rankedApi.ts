import { RANKED_SEASON } from "../src/ranked/protocol";
import type {
  LeaderboardRow,
  RankedHistoryRow,
  RankedHub,
  RankedMatchPlayerRow,
  RankedProfile,
} from "../src/ranked/protocol";
import { STARTING_RATING } from "../src/ranked/rating";
import { getUser } from "./auth";
import type { Env } from "./env";

// ---------------------------------------------------------------------------
// The ranked read API. One hub endpoint feeds the whole hub page — the
// session is resolved once and the queries go out as a single D1 batch — and
// one match endpoint serves a finished room's rating changes. All writes
// happen elsewhere (the ranked room's post-match batch); this only SELECTs.
// ---------------------------------------------------------------------------

const noStore = { headers: { "cache-control": "no-store" } };

/** Routes /api/ranked/*; null means "not one of ours". */
export async function handleRankedApi(request: Request, env: Env): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (!pathname.startsWith("/api/ranked/")) return null;
  if (pathname === "/api/ranked/hub") return hub(request, env);
  const match = pathname.match(/^\/api\/ranked\/match\/([A-Z2-9]{8})$/);
  if (match) return matchResults(env, match[1]);
  return new Response("Not found", { status: 404 });
}

async function hub(request: Request, env: Env): Promise<Response> {
  const user = await getUser(request, env);
  const db = env.AUTH_DB;

  const leaderboardQ = db
    .prepare(
      `SELECT p.userId AS userId, u.name AS name, u.image AS image,
              p.rating AS rating, p.gamesPlayed AS gamesPlayed
       FROM ranked_profile p JOIN user u ON u.id = p.userId
       WHERE p.season = ?
       ORDER BY p.rating DESC, p.gamesPlayed DESC, u.name ASC
       LIMIT 100`,
    )
    .bind(RANKED_SEASON);

  if (!user) {
    const leaderboard = (await leaderboardQ.all<LeaderboardRow>()).results;
    const body: RankedHub = { season: RANKED_SEASON, leaderboard, me: null, history: null };
    return Response.json(body, noStore);
  }

  const [leaderboard, me, history] = await db.batch([
    leaderboardQ,
    db
      .prepare(
        // The rank must count by the exact ordering the leaderboard displays
        // (rating, then games, then name) or ties would show different
        // positions on the two surfaces.
        `SELECT p.rating AS rating, p.gamesPlayed AS gamesPlayed,
                (SELECT COUNT(*) + 1
                 FROM ranked_profile o JOIN user ou ON ou.id = o.userId
                 WHERE o.season = p.season AND (
                   o.rating > p.rating
                   OR (o.rating = p.rating AND o.gamesPlayed > p.gamesPlayed)
                   OR (o.rating = p.rating AND o.gamesPlayed = p.gamesPlayed
                       AND ou.name < u.name)
                 )) AS rank
         FROM ranked_profile p JOIN user u ON u.id = p.userId
         WHERE p.season = ? AND p.userId = ?`,
      )
      .bind(RANKED_SEASON, user.id),
    db
      .prepare(
        `SELECT mp.matchId AS matchId, m.completedAt AS completedAt, mp.teamName AS teamName,
                mp.place AS place, mp.gamesWon AS gamesWon,
                mp.ratingBefore AS ratingBefore, mp.ratingExchange AS ratingExchange,
                mp.ratingBonus AS ratingBonus, mp.ratingAfter AS ratingAfter,
                (SELECT COUNT(*) FROM ranked_match_player o WHERE o.matchId = mp.matchId) AS players
         FROM ranked_match_player mp JOIN ranked_match m ON m.id = mp.matchId
         WHERE mp.userId = ?
         ORDER BY m.completedAt DESC
         LIMIT 50`,
      )
      .bind(user.id),
  ]);

  const body: RankedHub = {
    season: RANKED_SEASON,
    leaderboard: leaderboard.results as LeaderboardRow[],
    me:
      (me.results[0] as RankedProfile | undefined) ??
      ({ rating: STARTING_RATING, gamesPlayed: 0, rank: null } satisfies RankedProfile),
    history: history.results as RankedHistoryRow[],
  };
  return Response.json(body, noStore);
}

/** A finished match's per-player rating changes — public, like the room. */
async function matchResults(env: Env, code: string): Promise<Response> {
  const rows = await env.AUTH_DB.prepare(
    `SELECT userId, teamName, place, gamesWon,
            ratingBefore, ratingExchange, ratingBonus, ratingAfter
     FROM ranked_match_player WHERE matchId = ? ORDER BY seat`,
  )
    .bind(code)
    .all<RankedMatchPlayerRow>();
  if (!rows.results.length) return Response.json({ rows: [] }, { status: 404, ...noStore });
  return Response.json({ rows: rows.results }, noStore);
}
