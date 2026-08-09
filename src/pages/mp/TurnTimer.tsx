import { useNow } from "./useRoom";

const R = 34;
const CIRC = 2 * Math.PI * R;

/**
 * Floating countdown for your own pick — a ring that drains as time runs out.
 * Bone → trophy gold at 10s → dire red at 5s.
 */
export function TurnTimer({ deadline, totalSecs }: { deadline: number; totalSecs: number }) {
  const now = useNow(100);
  const msLeft = Math.max(0, deadline - now);
  const secs = Math.ceil(msLeft / 1000);
  const frac = Math.min(1, msLeft / (totalSecs * 1000));

  const stroke =
    secs <= 5 ? "var(--color-dire)" : secs <= 10 ? "var(--color-trophy)" : "var(--color-bone)";

  return (
    <div
      className="fixed bottom-5 left-5 z-50 h-20 w-20 rounded-full border border-ink-700 bg-ink-950/90 shadow-[0_4px_24px_rgba(0,0,0,0.6)]"
      title="Time left on your pick"
    >
      <svg viewBox="0 0 80 80" className="absolute inset-0 -rotate-90">
        <circle cx="40" cy="40" r={R} fill="none" stroke="var(--color-ink-700)" strokeWidth="5" />
        <circle
          cx="40"
          cy="40"
          r={R}
          fill="none"
          stroke={stroke}
          strokeWidth="5"
          strokeLinecap="round"
          strokeDasharray={CIRC}
          strokeDashoffset={CIRC * (1 - frac)}
          style={{
            transition: "stroke-dashoffset 0.1s linear, stroke 0.3s",
            filter: secs <= 10 ? `drop-shadow(0 0 6px ${stroke})` : undefined,
          }}
        />
      </svg>
      <span
        className={`absolute inset-0 flex items-center justify-center font-mono text-2xl font-extrabold tabular-nums ${
          secs <= 5 ? "anim-urgent text-dire" : secs <= 10 ? "text-trophy" : "text-bone"
        }`}
      >
        {secs}
      </span>
    </div>
  );
}
