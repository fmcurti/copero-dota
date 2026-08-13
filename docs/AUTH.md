# Authentication Design

Status: **foundation implemented 2026-08-13** — Better Auth/D1 handler,
Google OAuth, email OTP through a replaceable Resend adapter, optional account
UI, local migration, and server-side identity interface are present. The
production D1 database is provisioned and migrated; provider credentials still
need to be configured.

## Decision

Use [Better Auth](https://better-auth.com/) with Cloudflare D1 for optional
accounts. Authentication must remain an enhancement: the existing solo game,
room directory, casual lobbies, drafting, chat, and spectating continue to work
without signing in.

An account becomes mandatory only for features whose state must survive a
browser or device, initially ranked play and its rating/history records.

```text
Casual lobby  -> existing browser identity -> no account required
Ranked play   -> Better Auth user ID       -> account required
```

## Why Better Auth

- It runs inside the existing TypeScript Worker instead of gating the whole
  hostname before requests reach the app.
- The framework is free, open source, and MIT-licensed, with no per-user fee.
  Its hosted infrastructure is optional.
- It accepts standard `Request` and `Response` objects, so its handler can be
  mounted directly in `worker/index.ts` at `/api/auth/*`.
- Cloudflare D1 is a first-class database option: the Worker can pass its D1
  binding directly to Better Auth.
- Its normal cookie sessions work on the same origin already used by the SPA,
  HTTP endpoints, and PartyServer WebSockets.

Cloudflare Access was rejected for this use case. Its free plan is limited to
50 users, but the more important mismatch is architectural: Access is an
identity-aware proxy in front of the application. It is excellent for making a
whole private application available to an allowlist, but awkward when most of
the application must stay public and only selected features require accounts.

## Identity model

There are two deliberately separate identities.

### Casual identity

Casual rooms keep the current browser-local UUID from
`src/pages/mp/useRoom.ts`. It is sufficient for reconnecting to short-lived,
standalone rooms and does not create an auth database row for every visitor.

Do **not** enable Better Auth's anonymous-user plugin for casual play. Doing so
would couple every lobby connection to D1 without providing a benefit required
by the current game.

The current UUID is not proof of identity: it is supplied by the browser in
the WebSocket query string, and `playerId` values are visible in room
snapshots. It must never be accepted as identity for ratings, ranked results,
bans, moderation privileges, or other durable state. Hardening casual room
identity with a signed room capability can be considered separately; it is not
a reason to require accounts.

### Account identity

Authenticated features use only Better Auth's stable `session.user.id` as the
canonical user ID. Client-provided IDs, names, and query parameters are never
trusted for account ownership.

The application-facing auth module should remain small:

```ts
export interface AuthUser {
  id: string;
  name: string;
  image?: string;
}

export function getUser(request: Request): Promise<AuthUser | null>;
export function requireUser(request: Request): Promise<AuthUser>;
```

Better Auth remains an implementation detail behind that interface. Callers do
not need to know about its cookies, tables, provider tokens, or session model.

## Cloudflare layout

Add a D1 binding to `wrangler.jsonc` and construct the Better Auth instance
from the request's Worker environment. Route requests in this order:

1. `/api/auth/*` -> `auth.handler(request)`
2. Ranked HTTP endpoints -> `requireUser(request)`
3. Existing `/api/rooms` -> public
4. PartyServer routing
5. Static asset binding / SPA fallback

The assets configuration already has `/api/*` in `run_worker_first`, so the
authentication handler will reach the Worker instead of being swallowed by the
SPA fallback.

Keep the auth endpoints and frontend on `dotero.fmcurti.com.ar`. Same-origin
cookies avoid cross-origin cookie and Safari behavior, and no auth-specific
CORS configuration should be necessary.

Configure Better Auth to use Cloudflare's trusted `cf-connecting-ip` header for
its built-in rate limiting. Store production rate-limit state in D1 rather than
Worker memory, because Worker isolates are ephemeral and distributed.

## Sign-in method

The initial methods are Google OAuth and email OTP. Neither method stores an
application password. Email delivery sits behind `worker/email.ts`; its first
adapter uses Resend's free transactional-email allowance and can be replaced
without changing Better Auth or the client UI.

The SPA should expose authentication without interrupting guest play:

- Signed out: a small **Sign in** action in the header.
- Signed in: avatar/name and **Sign out**.
- Casual room actions: unchanged in either state.
- Ranked entry point: prompt for sign-in if no session exists.

Client-side route checks are only user experience. This project uses
`HashRouter`, so a path such as `#/ranked` is never sent to the Worker. Ranked
authorization must be enforced on every ranked HTTP mutation and on the ranked
WebSocket upgrade.

## Ranked seam

Ranked play should use a separate authenticated PartyServer route or Durable
Object class, rather than scattering `if (ranked)` checks through
`CoperoRoom`. For example:

```text
/parties/copero-room/:code  -> casual, guest identity allowed
/parties/ranked-room/:id    -> valid Better Auth session required
```

The ranked adapter can reuse the existing pure drafting and tournament modules,
while owning the additional requirements:

- Resolve and validate the session during the WebSocket upgrade.
- Reject unauthenticated upgrades before they reach the ranked room.
- Set connection identity from `session.user.id` only.
- Prevent the same account from occupying multiple seats.
- Write the authoritative result after the server-side match completes.

If cookie session caching is enabled for general UI performance, ranked entry
should force a database-backed session check so revoked or banned sessions do
not remain eligible until the cache expires.

Ranked rooms must not be creatable merely by sending a client configuration
flag. A matchmaking or ranked-entry endpoint should authorize the users and
create or issue access to the ranked room.

## Data ownership

Better Auth owns only authentication data:

- users
- provider accounts
- sessions
- verification records

The ranked module owns game data in separate D1 tables keyed by the Better Auth
user ID:

- ranked profile and current rating
- rating history
- completed matches and participants
- placement progress
- queue penalties, bans, or moderation state

Do not add game rules or rating calculations to Better Auth hooks. The
server-authoritative ranked module calculates and records results; auth only
answers who the caller is.

## Suggested implementation order

1. ✅ Create the production D1 database and apply the committed auth migration.
2. Configure Better Auth, Google, and Resend secrets in Cloudflare.
3. Register the production and local Google OAuth callback URLs.
4. Verify that solo, directory browsing, casual rooms, and spectators work with
   cookies absent.
5. Add ranked profile tables and authenticated ranked entry endpoints.
6. Add the separate ranked PartyServer adapter when ranked gameplay is built.

## Production setup

The `el-copero-auth` database has been created, its UUID is committed in the
`AUTH_DB` binding in `wrangler.jsonc`, and the auth migration has been applied.
For subsequent migrations, run:

```sh
npx wrangler d1 migrations apply AUTH_DB --remote
```

Create an OAuth 2.0 **Web application** in Google Cloud and register both
callback URLs:

```text
http://localhost:5173/api/auth/callback/google
https://dotero.fmcurti.com.ar/api/auth/callback/google
```

`BETTER_AUTH_SECRET` and `RESEND_API_KEY` live in Cloudflare's account-level
Secrets Store and are bound as internal `*_STORE` bindings through
`secrets_store_secrets` in `wrangler.jsonc`. The auth module resolves those
bindings with `get()` and also accepts ordinary names from Worker secrets or
local `.dev.vars` without binding-name collisions.

`GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are also stored there and bound
as internal `*_STORE` bindings. As an alternative for another deployment, they
can be set as per-Worker secrets:

```sh
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

The sender address is stored as `AUTH_EMAIL_FROM` in the account store and
bound as `AUTH_EMAIL_FROM_STORE`. Its value must be a full mailbox on the
verified Resend domain, for example:

```text
El Copero del Dota <auth@dotero.fmcurti.com.ar>
```

Deploy only after the remote migration succeeds. Missing provider variables do
not affect casual play; the sign-in dialog hides the unavailable methods.

## Sources

- [Better Auth introduction](https://better-auth.com/docs/introduction)
- [Better Auth installation and handler mounting](https://better-auth.com/docs/installation)
- [Better Auth session management](https://better-auth.com/docs/concepts/session-management)
- [Better Auth cookie behavior](https://better-auth.com/docs/concepts/cookies)
- [Better Auth Cloudflare D1 support](https://better-auth.com/blog/1-5)
- [Better Auth rate limiting on Cloudflare](https://better-auth.com/docs/concepts/rate-limit)
- [Better Auth email OTP](https://better-auth.com/docs/plugins/email-otp)
- [Better Auth Google provider](https://better-auth.com/docs/authentication/google)
- [Better Auth repository and MIT license](https://github.com/better-auth/better-auth)
- [Cloudflare D1 overview](https://developers.cloudflare.com/d1/)
- [Cloudflare Secrets Store Worker bindings](https://developers.cloudflare.com/secrets-store/integrations/workers/)
- [Cloudflare Access plans](https://www.cloudflare.com/plans/zero-trust-services/)
- [Resend pricing](https://resend.com/docs/knowledge-base/what-is-resend-pricing)
