import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { authClient } from "../auth/client";
import { fileToAvatarDataUrl } from "../auth/avatar";
import SignOutHook from "../auth/SignOutHook";
import { Section } from "../components/options";
import { WinPhrasesEditor } from "../components/WinPhrases";
import { NAME_MAX, sanitizeName } from "../mp/protocol";

// ---------------------------------------------------------------------------
// The drafter's identity page: the account fields Better Auth owns (nickname,
// avatar) and the victory taunts the run store owns. Nickname and avatar are
// what rooms, the ranked ladder, and match history display; taunts live on
// this device and follow you into any room you sit in.
// ---------------------------------------------------------------------------

export default function Profile() {
  const { data: session, isPending } = authClient.useSession();
  // Kept at the page's top level, not inside SignedInProfile: signing out
  // flips the session and swaps that branch away, but the hook modal must
  // survive to finish its yank animation.
  const [signingOut, setSigningOut] = useState<string | null>(null);

  return (
    <div className="mx-auto max-w-xl">
      <div className="mx-auto mb-10 max-w-xl text-center">
        <div className="plate-rules py-4">
          <h1 className="anim-title-in plate text-5xl font-extrabold leading-none text-bone">
            Profile
          </h1>
          <div
            className="anim-eyebrow-in plate ml-[0.4em] mt-1 text-lg text-slate-mid"
            style={{ animationDelay: "0.15s" }}
          >
            your drafter identity
          </div>
        </div>
      </div>

      {isPending ? (
        <p className="text-center text-sm text-slate-dim">Loading session…</p>
      ) : session?.user ? (
        <SignedInProfile
          name={session.user.name}
          email={session.user.email}
          image={session.user.image ?? null}
          onSignOut={() => setSigningOut(session.user.name || session.user.email)}
        />
      ) : (
        <div className="panel mx-auto max-w-sm rounded-xl px-4 py-4 text-center text-sm text-slate-mid">
          Your profile needs an account — sign in from the header.
          <div className="mt-2">
            <Link to="/" className="plate text-xs tracking-widest text-slate-dim hover:text-bone">
              or play casual without one →
            </Link>
          </div>
        </div>
      )}

      {signingOut !== null && (
        <SignOutHook name={signingOut} onClose={() => setSigningOut(null)} />
      )}
    </div>
  );
}

function SignedInProfile({
  name,
  email,
  image,
  onSignOut,
}: {
  name: string;
  email: string;
  image: string | null;
  onSignOut: () => void;
}) {
  return (
    <div className="space-y-8">
      <AvatarPanel name={name} email={email} image={image} />
      <Section label="Nickname">
        <NicknameForm current={name} />
      </Section>
      <Section label="Victory taunts">
        <WinPhrasesEditor />
      </Section>
      <div className="border-t border-ink-700/60 pt-6">
        <button
          type="button"
          onClick={onSignOut}
          className="w-full rounded-lg border border-ink-700 px-4 py-2.5 text-sm font-semibold text-slate-dim transition hover:border-dire-dim hover:text-dire sm:w-auto"
        >
          Log out
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function AvatarPanel({ name, email, image }: { name: string; email: string; image: string | null }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const save = async (next: string | null) => {
    setBusy(true);
    setProblem(null);
    const result = await authClient.updateUser({ image: next });
    setBusy(false);
    if (result.error) setProblem(result.error.message ?? "Could not update the avatar.");
  };

  const pick = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = ""; // re-picking the same file must fire again
    if (!file) return;
    try {
      await save(await fileToAvatarDataUrl(file));
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "Could not read that image.");
    }
  };

  return (
    <div className="panel rounded-xl p-5">
      <div className="flex items-center gap-5">
        <div className="relative h-24 w-24 shrink-0">
          {image ? (
            <img
              src={image}
              alt=""
              referrerPolicy="no-referrer"
              className={`h-24 w-24 rounded-xl border border-ink-600 object-cover ${busy ? "opacity-40" : ""}`}
            />
          ) : (
            <div
              className={`plate flex h-24 w-24 items-center justify-center rounded-xl border border-ink-600 bg-ink-800 text-5xl font-extrabold text-slate-dim ${busy ? "opacity-40" : ""}`}
            >
              {(sanitizeName(name)[0] ?? "?").toUpperCase()}
            </div>
          )}
          {busy && (
            <div className="plate absolute inset-0 flex items-center justify-center text-xs tracking-widest text-bone">
              …
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="plate truncate text-2xl font-bold text-bone">{name}</div>
          <div className="truncate text-xs text-slate-dim">{email}</div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => fileRef.current?.click()}
              className="rounded-lg border border-ink-600 px-3 py-1.5 text-sm font-semibold text-slate-strong transition hover:border-slate-mid hover:text-bone disabled:opacity-50"
            >
              {image ? "Change portrait" : "Upload portrait"}
            </button>
            {image && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void save(null)}
                className="rounded-lg border border-ink-700 px-3 py-1.5 text-sm text-slate-dim transition hover:border-dire-dim hover:text-dire disabled:opacity-50"
              >
                Remove
              </button>
            )}
          </div>
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => void pick(e)} />
          <p className="mt-2 text-xs text-slate-dim">
            Any image up to 8MB — cropped square, stored small.
          </p>
        </div>
      </div>
      {problem && <p className="mt-3 text-sm text-dire">{problem}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------

function NicknameForm({ current }: { current: string }) {
  const [nick, setNick] = useState(current);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  // An outside rename (another tab, OAuth sync) refreshes an untouched form.
  useEffect(() => setNick((prev) => (prev === current ? prev : current)), [current]);

  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), 2000);
    return () => clearTimeout(timer);
  }, [saved]);

  const clean = sanitizeName(nick);
  const changed = clean.length > 0 && clean !== current;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!changed || busy) return;
    setBusy(true);
    setProblem(null);
    const result = await authClient.updateUser({ name: clean });
    setBusy(false);
    if (result.error) setProblem(result.error.message ?? "Could not save the nickname.");
    else {
      setNick(clean);
      setSaved(true);
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="w-full space-y-2">
      <div className="flex w-full gap-2">
        <input
          value={nick}
          onChange={(event) => setNick(event.target.value)}
          maxLength={NAME_MAX}
          aria-label="Nickname"
          className="min-w-0 flex-1 rounded-lg border border-ink-700 bg-ink-900/40 px-4 py-2.5 text-sm text-bone outline-none focus:border-slate-mid"
        />
        <button
          type="submit"
          disabled={!changed || busy}
          className="cta-dota rounded-lg px-5 text-sm font-bold disabled:opacity-40"
        >
          {busy ? "…" : saved ? "Saved ✓" : "Save"}
        </button>
      </div>
      <p className="text-xs text-slate-dim">
        Shown in rooms, on the ranked ladder, and in match history.
      </p>
      {problem && <p className="text-sm text-dire">{problem}</p>}
    </form>
  );
}
