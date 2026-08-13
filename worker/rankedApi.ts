import { RANKED_SEASON } from "../src/ranked/protocol";
import { STARTING_RATING } from "../src/ranked/rating";
import { AuthenticationRequired, getUser } from "./auth";
import type { Env } from "./env";

// ---------------------------------------------------------------------------
// The ranked read API for the hub page. The leaderboard is public; profile and
// history require the caller's session. All writes happen elsewhere (the
// ranked room's post-match batch) — these endpoints only ever SELECT.
// ---------------------------------------------------------------------------

export interface LeaderboardRow {
  userId: string;
  name: string;
  image: string | null;
  rating: number;
  gamesPlayed: number;
}

export interface RankedProfile {
  rating: number;
  gamesPlayed: number;
  /** 1-based ladder position, or null before the first ranked game. */
  rank: number | null;
}

export interface RankedHistoryRow {
  matchId: string;
  completedAt: number;
  teamName: string;
  place: number;
  gamesWon: number;
  ratingBefore: number;
  ratingExchange: number;
  ratingBonus: number;
  ratingAfter: number;
  players: number;
}

/** Routes /api/ranked/*; null means "not one of ours". */
export async function handleRankedApi(request: Request, env: Env): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (!pathname.startsWith("/api/ranked/")) return null;
  try {
    if (pathname === "/api/ranked/leaderboard") return await leaderboard(env);
    if (pathname === "/api/ranked/me") return await profile(request, env);
    if (pathname === "/api/ranked/history") return await history(request, env);
    return new Response("Not found", { status: 404 });
  } catch (e) {
    if (e instanceof AuthenticationRequired) {
      return Response.json({ message: "Sign in for ranked." }, { status: 401 });
    }
    throw e;
  }
}

const noStore = { headers: { "cache-control": "no-store" } };

async function leaderboard(env: Env): Promise<Response> {
  const rows = await env.AUTH_DB.prepare(
    `SELECT p.userId AS userId, u.name AS name, u.image AS image,
            p.rating AS rating, p.gamesPlayed AS gamesPlayed
     FROM ranked_profile p JOIN user u ON u.id = p.userId
     WHERE p.season = ?
     ORDER BY p.rating DESC, p.gamesPlayed DESC, u.name ASC
     LIMIT 100`,
  )
    .bind(RANKED_SEASON)
    .all<LeaderboardRow>();
  return Response.json({ season: RANKED_SEASON, rows: rows.results }, noStore);
}

async function profile(request: Request, env: Env): Promise<Response> {
  const user = await getUser(request, env);
  if (!user) throw new AuthenticationRequired();
  const row = await env.AUTH_DB.prepare(
    `SELECT rating, gamesPlayed,
            (SELECT COUNT(*) + 1 FROM ranked_profile o
             WHERE o.season = p.season AND o.rating > p.rating) AS rank
     FROM ranked_profile p WHERE p.season = ? AND p.userId = ?`,
  )
    .bind(RANKED_SEASON, user.id)
    .first<{ rating: number; gamesPlayed: number; rank: number }>();
  const body: RankedProfile = row ?? { rating: STARTING_RATING, gamesPlayed: 0, rank: null };
  return Response.json(body, noStore);
}

async function history(request: Request, env: Env): Promise<Response> {
  const user = await getUser(request, env);
  if (!user) throw new AuthenticationRequired();
  const rows = await env.AUTH_DB.prepare(
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
    .bind(user.id)
    .all<RankedHistoryRow>();
  return Response.json({ rows: rows.results }, noStore);
}
