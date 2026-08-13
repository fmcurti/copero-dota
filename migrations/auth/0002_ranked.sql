-- Ranked module tables (docs/RANKED.md). They share the auth database so the
-- leaderboard can join account names, but Better Auth never touches them: the
-- server-authoritative ranked room is the only writer. Keyed by the Better
-- Auth user id. The ladder is eternal; every table still carries a season so
-- a future rollover is a data change, not a schema redesign.

CREATE TABLE "ranked_profile" (
  "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "season" INTEGER NOT NULL DEFAULT 1,
  "rating" INTEGER NOT NULL,
  "gamesPlayed" INTEGER NOT NULL DEFAULT 0,
  "createdAt" INTEGER NOT NULL,
  "updatedAt" INTEGER NOT NULL,
  PRIMARY KEY ("userId", "season")
);

CREATE INDEX "ranked_profile_ladder_idx" ON "ranked_profile" ("season", "rating" DESC);

-- One row per completed match; the id is the ranked room's code (unique,
-- queue-generated). Written once, idempotently, when the match completes.
CREATE TABLE "ranked_match" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "season" INTEGER NOT NULL DEFAULT 1,
  "config" TEXT NOT NULL,
  "simSeed" INTEGER NOT NULL,
  "startedAt" INTEGER NOT NULL,
  "completedAt" INTEGER NOT NULL
);

CREATE TABLE "ranked_match_player" (
  "matchId" TEXT NOT NULL REFERENCES "ranked_match"("id") ON DELETE CASCADE,
  "userId" TEXT NOT NULL REFERENCES "user"("id"),
  "seat" INTEGER NOT NULL,
  "teamName" TEXT NOT NULL,
  -- Tournament placement and its tiebreaker, as the standings table shows them.
  "place" INTEGER NOT NULL,
  "gamesWon" INTEGER NOT NULL,
  "ratingBefore" INTEGER NOT NULL,
  -- The zero-sum pairwise exchange and the TI-champion bonus, separately.
  "ratingExchange" INTEGER NOT NULL,
  "ratingBonus" INTEGER NOT NULL,
  "ratingAfter" INTEGER NOT NULL,
  PRIMARY KEY ("matchId", "userId")
);

CREATE INDEX "ranked_match_player_user_idx" ON "ranked_match_player" ("userId");
