// Shared option-picker UI used by the solo Home screen and the versus lobby.

export function OptionCard({
  title,
  desc,
  selected,
  onClick,
  disabled,
}: {
  title: string;
  desc: string;
  selected: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`grow basis-[calc(50%-0.25rem)] rounded-lg border px-3 py-2.5 text-left transition sm:w-56 sm:grow-0 sm:basis-auto sm:px-4 sm:py-3 ${
        selected
          ? "border-bone/70 bg-ink-800"
          : "border-ink-700 bg-ink-900/40 hover:border-ink-600"
      } ${disabled ? "cursor-not-allowed opacity-40" : ""}`}
    >
      <div className={`text-sm font-semibold ${selected ? "text-bone" : "text-slate-strong"}`}>
        {title}
      </div>
      <div className="mt-0.5 text-xs text-slate-dim">{desc}</div>
    </button>
  );
}

export function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="plate mb-2 text-sm tracking-widest text-slate-dim">{label}</div>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  );
}
