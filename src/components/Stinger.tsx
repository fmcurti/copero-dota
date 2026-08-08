import { useEffect } from "react";

/**
 * Full-screen broadcast stinger: gold rules sweep open around a big engraved
 * plate, holds a beat, then fades itself out (the .stinger CSS animation).
 * Purely visual — pointer events pass straight through. The parent unmounts
 * it via onDone; under reduced motion it resolves immediately.
 */
export function Stinger({
  eyebrow,
  title,
  sub,
  onDone,
}: {
  eyebrow: string;
  title: string;
  sub?: string;
  onDone: () => void;
}) {
  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const t = setTimeout(onDone, reduce ? 0 : 1450); // fade starts at 1s, ends at 1.4s
    return () => clearTimeout(t);
  }, [onDone]);
  return (
    <div className="stinger pointer-events-none">
      <div className="w-[min(600px,90vw)] text-center">
        <div className="anim-rule-grow h-px origin-left bg-gradient-to-r from-transparent via-trophy to-transparent" />
        <div className="py-7">
          <div className="anim-eyebrow-in plate text-sm text-trophy-dim">{eyebrow}</div>
          <div
            className="anim-title-in plate mt-2 truncate px-2 text-5xl font-extrabold leading-tight text-bone sm:text-6xl"
            style={{ animationDelay: "0.12s" }}
          >
            {title}
          </div>
          {sub && (
            <div
              className="anim-title-in mt-3 text-xs uppercase tracking-[0.35em] text-slate-mid"
              style={{ animationDelay: "0.32s" }}
            >
              {sub}
            </div>
          )}
        </div>
        <div className="anim-rule-grow h-px origin-right bg-gradient-to-r from-transparent via-trophy to-transparent" />
      </div>
    </div>
  );
}
