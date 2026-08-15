import { useEffect, useRef, useState } from "react";
import { authClient } from "./client";
import HookModal, { type HookController } from "./HookModal";

// ---------------------------------------------------------------------------
// The log-out confirmation, staged as a Pudge hook (the mechanism lives in
// HookModal). "Stay" makes the hook let go — the plate drops away. "Log out"
// yanks plate and drafter clean off the screen while signOut() runs under the
// animation.
// ---------------------------------------------------------------------------

export default function SignOutHook({ name, onClose }: { name: string; onClose: () => void }) {
  return (
    <HookModal onClose={onClose} ariaLabelledBy="signout-title" contentClassName="px-6 pb-6 pt-8 text-center">
      {(ctrl) => <SignOutPlate name={name} ctrl={ctrl} />}
    </HookModal>
  );
}

function SignOutPlate({ name, ctrl }: { name: string; ctrl: HookController }) {
  const stayRef = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (ctrl.armed) stayRef.current?.focus();
  }, [ctrl.armed]);

  const logOut = () => {
    setBusy(true);
    // Kick off the network call and let the yank play over it; the modal
    // closes when both finish.
    ctrl.yank(authClient.signOut().catch(() => undefined));
  };

  return (
    <>
      <div className="plate text-[11px] tracking-[0.35em]" style={{ color: "#9b8974" }}>
        the hook has you
      </div>
      <h2 id="signout-title" className="plate-italic mt-1 text-4xl text-bone">
        Logging out?
      </h2>
      <p className="mx-auto mt-3 max-w-[19rem] text-sm" style={{ color: "#cfc4b0" }}>
        Logged in as <span className="font-bold text-bone">{name}</span>. Ranked needs the account —
        casual play doesn&apos;t.
      </p>
      <div className="mt-5 flex gap-3">
        <button
          ref={stayRef}
          type="button"
          disabled={!ctrl.armed || busy}
          onClick={ctrl.close}
          className="flex-1 rounded-lg border border-ink-600 bg-ink-900/50 px-4 py-2.5 text-sm font-semibold text-slate-strong transition hover:border-slate-mid hover:text-bone disabled:opacity-50"
        >
          Stay
        </button>
        <button
          type="button"
          disabled={!ctrl.armed || busy}
          onClick={logOut}
          className="cta-dota flex-1 rounded-lg px-4 py-2.5 font-display text-sm font-bold uppercase tracking-wider disabled:opacity-60"
        >
          {busy ? "Logging out…" : "Log out"}
        </button>
      </div>
      <div className="plate-italic mt-4 text-[10px]" style={{ color: "#8a7a64" }}>
        — el gancho no perdona —
      </div>
    </>
  );
}
