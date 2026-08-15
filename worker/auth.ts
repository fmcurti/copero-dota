import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { emailOTP } from "better-auth/plugins";
import { DEFAULT_NAME, sanitizeName } from "../src/mp/protocol";
import { sendAuthOtp, type AuthEmailEnv } from "./email";

export interface AuthEnv extends AuthEmailEnv {
  AUTH_DB: D1Database;
  BETTER_AUTH_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  BETTER_AUTH_SECRET_STORE?: SecretsStoreSecret;
  GOOGLE_CLIENT_ID_STORE?: SecretsStoreSecret;
  GOOGLE_CLIENT_SECRET_STORE?: SecretsStoreSecret;
  RESEND_API_KEY_STORE?: SecretsStoreSecret;
  AUTH_EMAIL_FROM_STORE?: SecretsStoreSecret;
}

interface ResolvedAuthEnv extends AuthEmailEnv {
  AUTH_DB: D1Database;
  BETTER_AUTH_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
}

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  image?: string;
}

export class AuthenticationRequired extends Error {
  constructor() {
    super("Authentication required.");
    this.name = "AuthenticationRequired";
  }
}

const DEV_SECRET = "local-development-only-secret-change-me";

// ---------------------------------------------------------------------------
// User-write gate. Better Auth's /update-user endpoint is live for any signed
// in caller, so the profile fields it can touch are validated here — at the
// database hook, where every path (profile page, OAuth profile sync, email
// sign-up) converges — not in the UI.
// ---------------------------------------------------------------------------

/** Longest accepted avatar payload: a 256px JPEG data URL is ~15–55k chars. */
export const MAX_AVATAR_CHARS = 200_000;
const AVATAR_DATA_URL = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const MAX_IMAGE_URL_CHARS = 600;

function acceptableImage(image: string): boolean {
  if (image.length <= MAX_IMAGE_URL_CHARS && image.startsWith("https://")) return true;
  return image.length <= MAX_AVATAR_CHARS && AVATAR_DATA_URL.test(image);
}

/**
 * Validate a user row about to be written and return the fields to overwrite.
 * Names pass through the room-name sanitizer so the ladder and ranked seats
 * obey the same rules as casual seats; images must be an https URL (OAuth
 * avatars) or a bounded inline image (profile uploads). Bad input throws the
 * APIError that Better Auth turns into the endpoint's 4xx response.
 */
export function userWritePatch(
  data: Record<string, unknown>,
  mode: "create" | "update",
): { name?: string } {
  const { name, image } = data as { name?: unknown; image?: unknown };
  const patch: { name?: string } = {};

  if (name !== undefined) {
    if (typeof name !== "string") throw new APIError("BAD_REQUEST", { message: "Bad nickname." });
    const clean = sanitizeName(name);
    if (clean) patch.name = clean;
    else if (mode === "create") patch.name = DEFAULT_NAME;
    else throw new APIError("BAD_REQUEST", { message: "That nickname comes out empty." });
  }

  if (image !== undefined && image !== null) {
    if (typeof image !== "string" || !acceptableImage(image)) {
      throw new APIError("BAD_REQUEST", { message: "Avatar must be a small image." });
    }
  }

  return patch;
}

async function readSecret(
  direct: string | undefined,
  store: SecretsStoreSecret | undefined,
): Promise<string | undefined> {
  if (direct) return direct;
  if (!store) return undefined;
  try {
    return await store.get();
  } catch (error) {
    // Production bindings reference existing account secrets. Miniflare creates
    // the binding locally too, but its store is intentionally separate; allow
    // `.dev.vars`/the local-only Better Auth secret to handle that case.
    if (error instanceof Error && /^Secret ".+" not found$/.test(error.message)) return undefined;
    throw error;
  }
}

async function resolveAuthEnv(env: AuthEnv): Promise<ResolvedAuthEnv> {
  const [betterAuthSecret, googleClientId, googleClientSecret, resendApiKey, authEmailFrom] =
    await Promise.all([
      readSecret(env.BETTER_AUTH_SECRET, env.BETTER_AUTH_SECRET_STORE),
      readSecret(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_ID_STORE),
      readSecret(env.GOOGLE_CLIENT_SECRET, env.GOOGLE_CLIENT_SECRET_STORE),
      readSecret(env.RESEND_API_KEY, env.RESEND_API_KEY_STORE),
      readSecret(env.AUTH_EMAIL_FROM, env.AUTH_EMAIL_FROM_STORE),
    ]);
  return {
    AUTH_DB: env.AUTH_DB,
    BETTER_AUTH_SECRET: betterAuthSecret,
    GOOGLE_CLIENT_ID: googleClientId,
    GOOGLE_CLIENT_SECRET: googleClientSecret,
    RESEND_API_KEY: resendApiKey,
    AUTH_EMAIL_FROM: authEmailFrom,
  };
}

/** Local development detection — the only place relaxed auth rules may apply. */
export function isLocalDevHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

// The local-dev inbox: with no email provider configured, the latest code per
// address is held in memory so the sign-in dialog can display it instead of
// asking the player to dig through the dev-server terminal.
const devInbox = new Map<string, string>();

/**
 * Read the local-dev inbox. 404 outside localhost, and 404 whenever real
 * email delivery is configured — then codes travel by email and nothing is
 * ever stored here.
 */
export async function handleDevOtp(request: Request, env: AuthEnv): Promise<Response> {
  const url = new URL(request.url);
  if (!isLocalDevHost(url.hostname)) return new Response("Not found", { status: 404 });
  const resolved = await resolveAuthEnv(env);
  if (emailReady(resolved)) return new Response("Not found", { status: 404 });
  const email = (url.searchParams.get("email") ?? "").toLowerCase();
  return Response.json(
    { otp: devInbox.get(email) ?? null },
    { headers: { "cache-control": "no-store" } },
  );
}

function authSecret(origin: string, env: ResolvedAuthEnv): string {
  if (env.BETTER_AUTH_SECRET) return env.BETTER_AUTH_SECRET;
  if (isLocalDevHost(new URL(origin).hostname)) return DEV_SECRET;
  throw new Error("BETTER_AUTH_SECRET is required outside local development.");
}

function createAuth(request: Request, env: ResolvedAuthEnv) {
  const origin = new URL(request.url).origin;
  const googleReady = Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);

  return betterAuth({
    appName: "El Copero del Dota",
    baseURL: origin,
    secret: authSecret(origin, env),
    database: env.AUTH_DB,
    trustedOrigins: [origin],
    socialProviders: googleReady
      ? {
          google: {
            clientId: env.GOOGLE_CLIENT_ID!,
            clientSecret: env.GOOGLE_CLIENT_SECRET!,
            prompt: "select_account",
          },
        }
      : {},
    // Password accounts. Registration must prove the inbox before the first
    // sign-in; the emailOTP plugin below turns that proof into a 6-digit code
    // instead of Better Auth's default link email.
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
    },
    emailVerification: {
      // Verifying the register code IS the first sign-in, and a password
      // sign-in that reaches a not-yet-verified account re-sends a fresh code.
      autoSignInAfterVerification: true,
      sendOnSignIn: true,
    },
    plugins: [
      emailOTP({
        expiresIn: 300,
        allowedAttempts: 3,
        storeOTP: "hashed",
        overrideDefaultEmailVerification: true,
        async sendVerificationOTP({ email, otp }) {
          if (!emailReady(env)) {
            // The unconfigured-email fallback. The UI only offers email
            // flows on localhost then (capabilities); the dialog reads the
            // code back through /api/dev-otp, with the terminal as backup.
            devInbox.set(email.toLowerCase(), otp);
            console.log(`[auth] local sign-in code for ${email}: ${otp}`);
            return;
          }
          await sendAuthOtp(env, { email, otp });
        },
      }),
    ],
    databaseHooks: {
      user: {
        // Both hooks return only the corrected fields; Better Auth merges
        // them over the incoming write.
        create: { before: async (user) => ({ data: userWritePatch(user, "create") }) },
        update: { before: async (user) => ({ data: userWritePatch(user, "update") }) },
      },
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 100,
    },
    advanced: {
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
    },
  });
}

/** Better Auth's complete HTTP surface, kept behind the Worker routing seam. */
export async function handleAuth(request: Request, env: AuthEnv): Promise<Response> {
  const resolved = await resolveAuthEnv(env);
  const url = new URL(request.url);
  // Routes that depend on delivering a code: the OTP endpoints, and sign-up —
  // an account nobody can verify must not be creatable. Password sign-in
  // stays open so existing accounts survive an email-provider outage.
  const needsEmail =
    url.pathname.includes("email-otp") || url.pathname.endsWith("/sign-up/email");
  if (needsEmail && !emailReady(resolved) && !isLocalDevHost(url.hostname)) {
    return Response.json({ message: "Email sign-in is not configured." }, { status: 503 });
  }
  return createAuth(request, resolved).handler(request);
}

/** The only identity lookup ranked/application modules need to learn. */
export async function getUser(request: Request, env: AuthEnv): Promise<AuthUser | null> {
  const resolved = await resolveAuthEnv(env);
  const result = await createAuth(request, resolved).api.getSession({ headers: request.headers });
  if (!result?.user) return null;
  return {
    id: result.user.id,
    name: result.user.name,
    email: result.user.email,
    ...(result.user.image ? { image: result.user.image } : {}),
  };
}

export async function requireUser(request: Request, env: AuthEnv): Promise<AuthUser> {
  const user = await getUser(request, env);
  if (!user) throw new AuthenticationRequired();
  return user;
}

function emailReady(env: Pick<ResolvedAuthEnv, "RESEND_API_KEY" | "AUTH_EMAIL_FROM">) {
  return Boolean(env.RESEND_API_KEY && env.AUTH_EMAIL_FROM);
}

export async function authCapabilities(env: AuthEnv, hostname = "") {
  const [googleClientId, googleClientSecret, resendApiKey, authEmailFrom] = await Promise.all([
    readSecret(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_ID_STORE),
    readSecret(env.GOOGLE_CLIENT_SECRET, env.GOOGLE_CLIENT_SECRET_STORE),
    readSecret(env.RESEND_API_KEY, env.RESEND_API_KEY_STORE),
    readSecret(env.AUTH_EMAIL_FROM, env.AUTH_EMAIL_FROM_STORE),
  ]);
  return {
    google: Boolean(googleClientId && googleClientSecret),
    // Email codes remain a complete sign-in/sign-up method; passwords are an
    // optional second credential, never a migration requirement. Localhost
    // uses the in-memory dev inbox when no delivery provider is configured.
    emailOtp: Boolean(resendApiKey && authEmailFrom) || isLocalDevHost(hostname),
    // Password sign-in itself does not need email delivery. Registration and
    // recovery still pass through the email-gated endpoints above.
    password: true,
  };
}
