-- The name behind the nickname (docs/AUTH.md). Filled from the Google ID token
-- whenever a Google account row is written — sign-up and every later sign-in —
-- so existing players pick it up the next time they log in. Never set by the
-- client: the Better Auth field is `input: false`. Null for password accounts.
ALTER TABLE "user" ADD COLUMN "accountName" TEXT;
