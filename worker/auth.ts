import { betterAuth } from "better-auth";
import { emailOTP } from "better-auth/plugins";
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

function authSecret(origin: string, env: ResolvedAuthEnv): string {
  if (env.BETTER_AUTH_SECRET) return env.BETTER_AUTH_SECRET;
  const host = new URL(origin).hostname;
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return DEV_SECRET;
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
    plugins: [
      emailOTP({
        expiresIn: 300,
        allowedAttempts: 3,
        storeOTP: "hashed",
        async sendVerificationOTP({ email, otp }) {
          await sendAuthOtp(env, { email, otp });
        },
      }),
    ],
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
  if (new URL(request.url).pathname.includes("email-otp") && !emailReady(resolved)) {
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

export async function authCapabilities(env: AuthEnv) {
  const [googleClientId, googleClientSecret, resendApiKey, authEmailFrom] = await Promise.all([
    readSecret(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_ID_STORE),
    readSecret(env.GOOGLE_CLIENT_SECRET, env.GOOGLE_CLIENT_SECRET_STORE),
    readSecret(env.RESEND_API_KEY, env.RESEND_API_KEY_STORE),
    readSecret(env.AUTH_EMAIL_FROM, env.AUTH_EMAIL_FROM_STORE),
  ]);
  return {
    google: Boolean(googleClientId && googleClientSecret),
    emailOtp: Boolean(resendApiKey && authEmailFrom),
  };
}
