export function HumanTeamBadge({ self = false }: { self?: boolean }) {
  return (
    <span
      title={self ? "Your team" : "Human-controlled team"}
      className={`inline-flex shrink-0 items-center rounded-sm border px-1 py-px font-mono text-[8px] font-extrabold uppercase leading-none ${
        self
          ? "border-trophy-dim bg-trophy/10 text-trophy"
          : "border-radiant-dim bg-radiant/10 text-radiant"
      }`}
    >
      {self ? "YOU" : "HUMAN"}
    </span>
  );
}
