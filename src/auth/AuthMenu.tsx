import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { Link } from "react-router-dom";
import { authClient } from "./client";
import HookModal from "./HookModal";
import { NAME_MAX, sanitizeName } from "../mp/protocol";

interface AuthCapabilities {
  google: boolean;
  emailOtp: boolean;
  password: boolean;
}

const DEFAULT_CAPABILITIES: AuthCapabilities = {
  google: false,
  emailOtp: false,
  password: false,
};

const onLocalhost = () => ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);

const FIELD_LABEL = "block text-xs uppercase tracking-widest text-slate-mid";
const FIELD_INPUT =
  "mt-1.5 w-full border border-ink-600 bg-ink-950 px-3 py-2 text-base normal-case tracking-normal text-bone disabled:opacity-60";

export default function AuthMenu() {
  const { data: session, isPending } = authClient.useSession();
  const [open, setOpen] = useState(false);
  const [capabilities, setCapabilities] = useState(DEFAULT_CAPABILITIES);
  // The dialog is a tiny machine: pick an independent sign-in method, or
  // prove the inbox. OTP remains a complete passwordless sign-in/sign-up path.
  // Password registration passes through "verify"; a password sign-in only
  // lands there when the account never finished verifying (the server re-sends).
  // "reset" sets a new password by code — including the FIRST password of an
  // account from the email-code era, which has none to forget.
  const [mode, setMode] = useState<"signin" | "register" | "verify" | "reset">("signin");
  const [signInMethod, setSignInMethod] = useState<"otp" | "password">("otp");
  const [otpSent, setOtpSent] = useState(false);
  const [resetSent, setResetSent] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [nick, setNick] = useState("");
  const [otp, setOtp] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Local dev has no real inbox — the worker holds the last code per address
  // and the dialog shows it right under the input.
  const [devOtp, setDevOtp] = useState<string | null>(null);

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
    setMode("signin");
    setSignInMethod("otp");
    setOtpSent(false);
    setResetSent(false);
    setPassword("");
    setOtp("");
    setProblem(null);
    setNotice(null);
    setDevOtp(null);
  };

  const switchMode = (next: "signin" | "register" | "reset") => {
    setMode(next);
    setOtpSent(false);
    setResetSent(false);
    setProblem(null);
    setNotice(null);
    setDevOtp(null);
  };

  const switchSignInMethod = (next: "otp" | "password") => {
    setSignInMethod(next);
    setOtpSent(false);
    setOtp("");
    setPassword("");
    setProblem(null);
    setNotice(null);
    setDevOtp(null);
  };

  /** Pull the just-sent code from the local-dev inbox (no-op in production).
   *  The send may finish in the background, so poll a few times. */
  const fetchDevCode = (target: string) => {
    if (!onLocalhost()) return;
    let tries = 0;
    const attempt = async () => {
      tries += 1;
      try {
        const response = await fetch(`/api/dev-otp?email=${encodeURIComponent(target)}`, {
          headers: { accept: "application/json" },
        });
        if (!response.ok) return;
        const { otp: code } = (await response.json()) as { otp: string | null };
        if (code) {
          setDevOtp(code);
          setOtp((prev) => (prev === "" ? code : prev));
          return;
        }
      } catch {
        return; // a dev nicety must never break the flow
      }
      if (tries < 3) setTimeout(() => void attempt(), 500 * tries);
    };
    void attempt();
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

  const submitSignIn = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    const result = await authClient.signIn.email({ email, password });
    setBusy(false);
    if (!result.error) {
      close();
      return;
    }
    if (result.error.status === 403) {
      // Right password, unverified email — the server just sent a new code.
      setMode("verify");
      setOtp("");
      setNotice(`Your email was never verified. We sent a new code to ${email}.`);
      fetchDevCode(email);
    } else {
      setProblem(result.error.message ?? "Could not sign in.");
    }
  };

  const submitOtpSignIn = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    if (!otpSent) {
      const result = await authClient.emailOtp.sendVerificationOtp({
        email,
        type: "sign-in",
      });
      setBusy(false);
      if (result.error) {
        setProblem(result.error.message ?? "Could not send the code.");
      } else {
        setOtpSent(true);
        setOtp("");
        setNotice(`We emailed a 6-digit sign-in code to ${email}.`);
        fetchDevCode(email);
      }
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

  const submitRegister = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    const result = await authClient.signUp.email({
      name: sanitizeName(nick) || email.split("@")[0],
      email,
      password,
    });
    setBusy(false);
    if (result.error) {
      setProblem(result.error.message ?? "Could not create the account.");
    } else {
      setMode("verify");
      setOtp("");
      setNotice(`We emailed a 6-digit code to ${email}.`);
      fetchDevCode(email);
    }
  };

  const submitVerify = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    const result = await authClient.emailOtp.verifyEmail({ email, otp });
    setBusy(false);
    if (result.error) setProblem(result.error.message ?? "That code is invalid or expired.");
    else close(); // verifying signs you in; the header follows the session
  };

  const resend = async () => {
    setBusy(true);
    setProblem(null);
    const result = await authClient.emailOtp.sendVerificationOtp({
      email,
      type: "email-verification",
    });
    setBusy(false);
    if (result.error) {
      setProblem(result.error.message ?? "Could not send a new code.");
    } else {
      setOtp("");
      setNotice(`New code sent to ${email}.`);
      fetchDevCode(email);
    }
  };

  const requestResetCode = async (): Promise<boolean> => {
    setBusy(true);
    setProblem(null);
    const result = await authClient.emailOtp.requestPasswordReset({ email });
    setBusy(false);
    if (result.error) {
      setProblem(result.error.message ?? "Could not send the code.");
      return false;
    }
    setNotice(`We emailed a 6-digit code to ${email}.`);
    return true;
  };

  const submitResetRequest = async (event: FormEvent) => {
    event.preventDefault();
    if (await requestResetCode()) {
      setResetSent(true);
      setOtp("");
      setPassword("");
      fetchDevCode(email);
    }
  };

  const resendResetCode = async () => {
    if (await requestResetCode()) {
      setOtp("");
      fetchDevCode(email);
    }
  };

  const submitResetConfirm = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    // For an account from the email-code era this CREATES its credential
    // record — the reset flow is also the migration path to passwords.
    const result = await authClient.emailOtp.resetPassword({ email, otp, password });
    if (result.error) {
      setBusy(false);
      setProblem(result.error.message ?? "That code is invalid or expired.");
      return;
    }
    const signin = await authClient.signIn.email({ email, password });
    setBusy(false);
    if (signin.error) {
      setMode("signin");
      setProblem(signin.error.message ?? "Password saved — sign in with it.");
    } else {
      close();
    }
  };

  const signedOutMenu = (
    <button
      type="button"
      onClick={() => setOpen(true)}
      className="plate text-sm tracking-widest text-slate-mid transition hover:text-bone"
    >
      Sign in
    </button>
  );

  const activeSignInMethod =
    signInMethod === "otp" && !capabilities.emailOtp ? "password" : signInMethod;

  // Rendered at a stable top-level position (like the log-out hook), never
  // inside a header branch: session refetches and pending flips must not
  // remount the dialog mid-form. The Pudge hook drags the whole sign-in plate
  // in; it keeps the same gentle perpetual hang, with the rust flakes off so
  // nothing falls on the form.
  const authDialog =
    open && !session?.user ? (
      <HookModal onClose={close} ariaLabelledBy="auth-title" flakes={false} contentClassName="px-6 pb-6 pt-6">
        {(ctrl) => (
          <AutoHeight>
            <div className="mb-5 flex items-start justify-between gap-4">
              <div>
                <h2 id="auth-title" className="plate text-2xl font-bold text-bone">
                  {mode === "verify"
                    ? "Check your email"
                    : mode === "reset"
                      ? "Reset password"
                      : mode === "register"
                        ? "Create account"
                        : "Sign in"}
                </h2>
                <p className="mt-1 text-sm text-slate-mid">
                  {mode === "verify"
                    ? notice
                    : mode === "reset"
                      ? resetSent
                        ? notice
                        : "We'll email you a code to set a new password — including a first one for accounts from the sign-in-code days."
                      : "Optional for casual play. Your account will be used for ranked modes."}
                </p>
              </div>
              <button
                type="button"
                onClick={ctrl.close}
                aria-label="Close sign in"
                className="text-xl text-slate-dim hover:text-bone"
              >
                ×
              </button>
            </div>

            {(mode === "signin" || mode === "register") && capabilities.google && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void google()}
                className="w-full border border-ink-600 bg-ink-800 px-4 py-2.5 text-sm font-bold text-bone transition hover:border-trophy-dim disabled:opacity-50"
              >
                Continue with Google
              </button>
            )}

            {(mode === "signin" || mode === "register") &&
              capabilities.google &&
              (capabilities.emailOtp || capabilities.password) && (
              <div className="my-4 flex items-center gap-3 text-xs uppercase tracking-widest text-slate-dim">
                <span className="h-px flex-1 bg-ink-700" /> or <span className="h-px flex-1 bg-ink-700" />
              </div>
            )}

            {(mode === "signin" || mode === "register") &&
              (capabilities.emailOtp || capabilities.password) && (
              <>
                {capabilities.emailOtp && capabilities.password && (
                  <div className="relative mb-4 flex rounded-lg border border-ink-700 bg-ink-950/60 p-1">
                    <span
                      aria-hidden
                      className="pointer-events-none absolute inset-y-1 left-1 w-[calc(50%-0.25rem)] rounded-md bg-ink-800 shadow-[inset_0_1px_0_rgba(233,229,218,0.08)] transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]"
                      style={{ transform: mode === "register" ? "translateX(100%)" : "translateX(0)" }}
                    />
                    {(["signin", "register"] as const).map((tab) => (
                      <button
                        key={tab}
                        type="button"
                        onClick={() => switchMode(tab)}
                        className={`plate relative z-10 flex-1 rounded-md px-3 py-1.5 text-xs tracking-widest transition-colors duration-200 ${
                          mode === tab ? "text-bone" : "text-slate-dim hover:text-slate-strong"
                        }`}
                      >
                        {tab === "signin" ? "Sign in" : "Create with password"}
                      </button>
                    ))}
                  </div>
                )}

                {mode === "signin" ? (
                  <div className="space-y-3">
                    {capabilities.emailOtp && capabilities.password && (
                      <div className="grid grid-cols-2 gap-2" aria-label="Email sign-in method">
                        {(["otp", "password"] as const).map((method) => (
                          <button
                            key={method}
                            type="button"
                            disabled={busy}
                            onClick={() => switchSignInMethod(method)}
                            className={`border px-3 py-2 text-xs uppercase tracking-widest transition ${
                              activeSignInMethod === method
                                ? "border-trophy-dim bg-ink-800 text-bone"
                                : "border-ink-700 bg-ink-950/60 text-slate-dim hover:text-slate-strong"
                            }`}
                          >
                            {method === "otp" ? "Email code" : "Password"}
                          </button>
                        ))}
                      </div>
                    )}

                    {activeSignInMethod === "otp" && capabilities.emailOtp ? (
                      <form
                        key="otp-signin"
                        onSubmit={(event) => void submitOtpSignIn(event)}
                        className="beat-in space-y-3"
                      >
                        <label className={FIELD_LABEL}>
                          Email
                          <input
                            type="email"
                            required
                            autoComplete="email"
                            disabled={otpSent || busy}
                            value={email}
                            onChange={(event) => setEmail(event.target.value)}
                            className={FIELD_INPUT}
                          />
                        </label>
                        {otpSent && (
                          <label className={FIELD_LABEL}>
                            Six-digit code
                            <input
                              inputMode="numeric"
                              autoComplete="one-time-code"
                              autoFocus
                              required
                              minLength={6}
                              maxLength={6}
                              value={otp}
                              onChange={(event) => setOtp(event.target.value.replace(/\D/g, ""))}
                              className="mt-1.5 w-full border border-ink-600 bg-ink-950 px-3 py-2 text-center font-mono text-xl tracking-[0.4em] text-bone"
                            />
                          </label>
                        )}
                        {otpSent && notice && <p className="text-xs text-slate-mid">{notice}</p>}
                        {!otpSent && (
                          <p className="text-xs text-slate-dim">
                            No password needed. If the email is new, its first valid code creates the account.
                          </p>
                        )}
                        <button
                          type="submit"
                          disabled={busy}
                          className="cta-dota w-full px-4 py-2.5 font-display text-base font-bold uppercase tracking-wider disabled:opacity-50"
                        >
                          {busy ? "Working…" : otpSent ? "Verify code" : "Email me a code"}
                        </button>
                        {otpSent && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => {
                              setOtpSent(false);
                              setOtp("");
                              setProblem(null);
                              setNotice(null);
                              setDevOtp(null);
                            }}
                            className="w-full text-xs text-slate-dim hover:text-slate-strong"
                          >
                            Use a different email
                          </button>
                        )}
                        {otpSent && onLocalhost() && (
                          <p className="text-xs text-slate-dim">
                            {devOtp ? (
                              <>
                                local dev inbox — your code is{" "}
                                <span className="font-mono text-base tracking-widest text-bone">{devOtp}</span>
                              </>
                            ) : (
                              <>
                                local dev: the code is printed in the <code>npm run dev</code> terminal
                              </>
                            )}
                          </p>
                        )}
                      </form>
                    ) : (
                      <form
                        key="password-signin"
                        onSubmit={(event) => void submitSignIn(event)}
                        className="beat-in space-y-3"
                      >
                        <label className={FIELD_LABEL}>
                          Email
                          <input
                            type="email"
                            required
                            autoComplete="email"
                            disabled={busy}
                            value={email}
                            onChange={(event) => setEmail(event.target.value)}
                            className={FIELD_INPUT}
                          />
                        </label>
                        <label className={FIELD_LABEL}>
                          Password
                          <input
                            type="password"
                            required
                            autoComplete="current-password"
                            disabled={busy}
                            value={password}
                            onChange={(event) => setPassword(event.target.value)}
                            className={FIELD_INPUT}
                          />
                        </label>
                        <button
                          type="submit"
                          disabled={busy}
                          className="cta-dota w-full px-4 py-2.5 font-display text-base font-bold uppercase tracking-wider disabled:opacity-50"
                        >
                          {busy ? "Working…" : "Sign in with password"}
                        </button>
                        {capabilities.emailOtp && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => switchMode("reset")}
                            className="w-full text-xs text-slate-dim hover:text-slate-strong"
                          >
                            Forgot password?
                          </button>
                        )}
                      </form>
                    )}
                  </div>
                ) : (
                  <form
                    key="register"
                    onSubmit={(event) => void submitRegister(event)}
                    className="beat-in space-y-3"
                  >
                    <label className={FIELD_LABEL}>
                      Nickname
                      <input
                        autoComplete="nickname"
                        maxLength={NAME_MAX}
                        placeholder="how you'll appear in rooms"
                        disabled={busy}
                        value={nick}
                        onChange={(event) => setNick(event.target.value)}
                        className={FIELD_INPUT}
                      />
                    </label>
                    <label className={FIELD_LABEL}>
                      Email
                      <input
                        type="email"
                        required
                        autoComplete="email"
                        disabled={busy}
                        value={email}
                        onChange={(event) => setEmail(event.target.value)}
                        className={FIELD_INPUT}
                      />
                    </label>
                    <label className={FIELD_LABEL}>
                      Password
                      <input
                        type="password"
                        required
                        minLength={8}
                        autoComplete="new-password"
                        disabled={busy}
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        className={FIELD_INPUT}
                      />
                      <span className="mt-1 block text-[10px] normal-case tracking-normal text-slate-dim">
                        8+ characters — we email a code to verify the address
                      </span>
                    </label>
                    <button
                      type="submit"
                      disabled={busy}
                      className="cta-dota w-full px-4 py-2.5 font-display text-base font-bold uppercase tracking-wider disabled:opacity-50"
                    >
                      {busy ? "Working…" : "Create account"}
                    </button>
                  </form>
                )}
              </>
            )}

            {mode === "reset" &&
              (resetSent ? (
                <form onSubmit={(event) => void submitResetConfirm(event)} className="space-y-3">
                  <label className={FIELD_LABEL}>
                    Six-digit code
                    <input
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      autoFocus
                      required
                      minLength={6}
                      maxLength={6}
                      value={otp}
                      onChange={(event) => setOtp(event.target.value.replace(/\D/g, ""))}
                      className="mt-1.5 w-full border border-ink-600 bg-ink-950 px-3 py-2 text-center font-mono text-xl tracking-[0.4em] text-bone"
                    />
                  </label>
                  <label className={FIELD_LABEL}>
                    New password
                    <input
                      type="password"
                      required
                      minLength={8}
                      autoComplete="new-password"
                      disabled={busy}
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      className={FIELD_INPUT}
                    />
                  </label>
                  <button
                    type="submit"
                    disabled={busy}
                    className="cta-dota w-full px-4 py-2.5 font-display text-base font-bold uppercase tracking-wider disabled:opacity-50"
                  >
                    {busy ? "Working…" : "Set new password"}
                  </button>
                  <div className="flex items-center justify-between">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void resendResetCode()}
                      className="text-xs text-slate-dim hover:text-slate-strong"
                    >
                      Resend code
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => switchMode("signin")}
                      className="text-xs text-slate-dim hover:text-slate-strong"
                    >
                      Back
                    </button>
                  </div>
                  {onLocalhost() && (
                    <p className="text-xs text-slate-dim">
                      {devOtp ? (
                        <>
                          local dev inbox — your code is{" "}
                          <span className="font-mono text-base tracking-widest text-bone">{devOtp}</span>
                        </>
                      ) : (
                        <>
                          local dev: the code is printed in the <code>npm run dev</code> terminal
                        </>
                      )}
                    </p>
                  )}
                </form>
              ) : (
                <form onSubmit={(event) => void submitResetRequest(event)} className="space-y-3">
                  <label className={FIELD_LABEL}>
                    Email
                    <input
                      type="email"
                      required
                      autoComplete="email"
                      autoFocus
                      disabled={busy}
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      className={FIELD_INPUT}
                    />
                  </label>
                  <button
                    type="submit"
                    disabled={busy}
                    className="cta-dota w-full px-4 py-2.5 font-display text-base font-bold uppercase tracking-wider disabled:opacity-50"
                  >
                    {busy ? "Working…" : "Email me a code"}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => switchMode("signin")}
                    className="w-full text-xs text-slate-dim hover:text-slate-strong"
                  >
                    Back to sign in
                  </button>
                </form>
              ))}

            {mode === "verify" && (
              <form onSubmit={(event) => void submitVerify(event)} className="space-y-3">
                <label className={FIELD_LABEL}>
                  Six-digit code
                  <input
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    autoFocus
                    required
                    minLength={6}
                    maxLength={6}
                    value={otp}
                    onChange={(event) => setOtp(event.target.value.replace(/\D/g, ""))}
                    className="mt-1.5 w-full border border-ink-600 bg-ink-950 px-3 py-2 text-center font-mono text-xl tracking-[0.4em] text-bone"
                  />
                </label>
                <button
                  type="submit"
                  disabled={busy}
                  className="cta-dota w-full px-4 py-2.5 font-display text-base font-bold uppercase tracking-wider disabled:opacity-50"
                >
                  {busy ? "Working…" : "Verify code"}
                </button>
                <div className="flex items-center justify-between">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void resend()}
                    className="text-xs text-slate-dim hover:text-slate-strong"
                  >
                    Resend code
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => switchMode("signin")}
                    className="text-xs text-slate-dim hover:text-slate-strong"
                  >
                    Back
                  </button>
                </div>
                {onLocalhost() && (
                  <p className="text-xs text-slate-dim">
                    {devOtp ? (
                      <>
                        local dev inbox — your code is{" "}
                        <span className="font-mono text-base tracking-widest text-bone">{devOtp}</span>
                      </>
                    ) : (
                      <>
                        local dev: the code is printed in the <code>npm run dev</code> terminal
                      </>
                    )}
                  </p>
                )}
              </form>
            )}

            {!capabilities.google && !capabilities.emailOtp && !capabilities.password && (
              <p className="border border-ink-700 bg-ink-950/60 p-3 text-sm text-slate-mid">
                Sign-in providers have not been configured yet. Casual play is still available.
              </p>
            )}

            {problem && <p className="mt-3 text-sm text-dire">{problem}</p>}
          </AutoHeight>
        )}
      </HookModal>
    ) : null;

  // authDialog sits at a stable child position so a session refetch can't
  // remount the sign-in form mid-entry. Sign-out now lives on the profile page.
  return (
    <>
      {isPending ? (
        <div className="h-8 w-16" aria-label="Loading account" />
      ) : session?.user ? (
        <Link
          to="/profile"
          title="Your profile"
          className="group flex min-w-0 items-center gap-2"
        >
          {session.user.image ? (
            <img
              src={session.user.image}
              alt=""
              referrerPolicy="no-referrer"
              className="h-7 w-7 rounded-full border border-ink-600 object-cover transition group-hover:border-trophy-dim"
            />
          ) : (
            <span className="plate flex h-7 w-7 items-center justify-center rounded-full border border-ink-600 bg-ink-800 text-xs font-bold text-slate-mid transition group-hover:border-trophy-dim">
              {(session.user.name || session.user.email)[0]?.toUpperCase()}
            </span>
          )}
          <span className="hidden max-w-28 truncate text-sm text-bone sm:block">
            {session.user.name || session.user.email}
          </span>
        </Link>
      ) : (
        signedOutMenu
      )}
      {authDialog}
    </>
  );
}

/**
 * Animates its own height as the content inside changes size, so the sign-in
 * plate grows and shrinks smoothly between login and register instead of
 * jumping. Clipping is on only while a height transition runs, so a settled
 * form never has its focus glow cut at the edges.
 */
function AutoHeight({ children }: { children: ReactNode }) {
  const inner = useRef<HTMLDivElement>(null);
  const measured = useRef<number | null>(null);
  const [height, setHeight] = useState<number | "auto">("auto");
  const [clip, setClip] = useState(false);

  useLayoutEffect(() => {
    const el = inner.current;
    if (!el) return;
    const measure = () => {
      const next = el.offsetHeight;
      if (measured.current !== null && measured.current !== next) setClip(true);
      measured.current = next;
      setHeight(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      onTransitionEnd={(event) => {
        if (event.propertyName === "height") setClip(false);
      }}
      style={{
        height,
        overflow: clip ? "hidden" : "visible",
        transition: "height 260ms cubic-bezier(0.16, 1, 0.3, 1)",
      }}
    >
      <div ref={inner}>{children}</div>
    </div>
  );
}
