import { useEffect, useState, type FormEvent } from "react";
import { authClient } from "./client";

interface AuthCapabilities {
  google: boolean;
  emailOtp: boolean;
}

const DEFAULT_CAPABILITIES: AuthCapabilities = { google: false, emailOtp: false };

export default function AuthMenu() {
  const { data: session, isPending } = authClient.useSession();
  const [open, setOpen] = useState(false);
  const [capabilities, setCapabilities] = useState(DEFAULT_CAPABILITIES);
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void fetch("/api/auth-config", { headers: { accept: "application/json" } })
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        return response.json() as Promise<AuthCapabilities>;
      })
      .then((value) => {
        if (live) setCapabilities(value);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  const close = () => {
    setOpen(false);
    setProblem(null);
    setOtp("");
    setSent(false);
  };

  const google = async () => {
    setBusy(true);
    setProblem(null);
    const result = await authClient.signIn.social({
      provider: "google",
      callbackURL: window.location.href,
    });
    if (result.error) {
      setProblem(result.error.message ?? "Google sign-in failed.");
      setBusy(false);
    }
  };

  const submitEmail = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    if (!sent) {
      const result = await authClient.emailOtp.sendVerificationOtp({
        email,
        type: "sign-in",
      });
      if (result.error) setProblem(result.error.message ?? "Could not send the code.");
      else setSent(true);
      setBusy(false);
      return;
    }

    const result = await authClient.signIn.emailOtp({
      email,
      otp,
      name: email.split("@")[0],
    });
    setBusy(false);
    if (result.error) setProblem(result.error.message ?? "That code is invalid or expired.");
    else close();
  };

  if (isPending) return <div className="h-8 w-16" aria-label="Loading account" />;

  if (session?.user) {
    return (
      <div className="flex items-center gap-2">
        {session.user.image && (
          <img
            src={session.user.image}
            alt=""
            referrerPolicy="no-referrer"
            className="h-7 w-7 rounded-full border border-ink-600"
          />
        )}
        <span className="hidden max-w-28 truncate text-sm text-bone sm:block">
          {session.user.name || session.user.email}
        </span>
        <button
          type="button"
          onClick={() => void authClient.signOut()}
          className="plate text-xs tracking-widest text-slate-dim transition hover:text-slate-strong"
        >
          Sign out
        </button>
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="plate text-sm tracking-widest text-slate-mid transition hover:text-bone"
      >
        Sign in
      </button>
      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="auth-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 px-4"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) close();
          }}
        >
          <div className="panel w-full max-w-sm p-6">
            <div className="mb-5 flex items-start justify-between gap-4">
              <div>
                <h2 id="auth-title" className="plate text-2xl font-bold text-bone">
                  Sign in
                </h2>
                <p className="mt-1 text-sm text-slate-mid">
                  Optional for casual play. Your account will be used for ranked modes.
                </p>
              </div>
              <button
                type="button"
                onClick={close}
                aria-label="Close sign in"
                className="text-xl text-slate-dim hover:text-bone"
              >
                ×
              </button>
            </div>

            {capabilities.google && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void google()}
                className="w-full border border-ink-600 bg-ink-800 px-4 py-2.5 text-sm font-bold text-bone transition hover:border-trophy-dim disabled:opacity-50"
              >
                Continue with Google
              </button>
            )}

            {capabilities.google && capabilities.emailOtp && (
              <div className="my-4 flex items-center gap-3 text-xs uppercase tracking-widest text-slate-dim">
                <span className="h-px flex-1 bg-ink-700" /> or <span className="h-px flex-1 bg-ink-700" />
              </div>
            )}

            {capabilities.emailOtp && (
              <form onSubmit={(event) => void submitEmail(event)} className="space-y-3">
                <label className="block text-xs uppercase tracking-widest text-slate-mid">
                  Email
                  <input
                    type="email"
                    required
                    autoComplete="email"
                    disabled={sent || busy}
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    className="mt-1.5 w-full border border-ink-600 bg-ink-950 px-3 py-2 text-base normal-case tracking-normal text-bone disabled:opacity-60"
                  />
                </label>
                {sent && (
                  <label className="block text-xs uppercase tracking-widest text-slate-mid">
                    Six-digit code
                    <input
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      required
                      minLength={6}
                      maxLength={6}
                      value={otp}
                      onChange={(event) => setOtp(event.target.value.replace(/\D/g, ""))}
                      className="mt-1.5 w-full border border-ink-600 bg-ink-950 px-3 py-2 text-center font-mono text-xl tracking-[0.4em] text-bone"
                    />
                  </label>
                )}
                <button
                  type="submit"
                  disabled={busy}
                  className="cta-dota w-full px-4 py-2.5 font-display text-base font-bold uppercase tracking-wider disabled:opacity-50"
                >
                  {busy ? "Working…" : sent ? "Verify code" : "Email me a code"}
                </button>
                {sent && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setSent(false);
                      setOtp("");
                      setProblem(null);
                    }}
                    className="w-full text-xs text-slate-dim hover:text-slate-strong"
                  >
                    Use a different email
                  </button>
                )}
              </form>
            )}

            {!capabilities.google && !capabilities.emailOtp && (
              <p className="border border-ink-700 bg-ink-950/60 p-3 text-sm text-slate-mid">
                Sign-in providers have not been configured yet. Casual play is still available.
              </p>
            )}

            {problem && <p className="mt-3 text-sm text-dire">{problem}</p>}
          </div>
        </div>
      )}
    </>
  );
}
