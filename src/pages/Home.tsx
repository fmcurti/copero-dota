import { useNavigate } from "react-router-dom";
import { OptionCard, Section } from "../components/options";
import { useRunStore } from "../game/store";
import type { CardMode, GameFormat, HeroAlloc } from "../game/types";

const FORMATS: { id: GameFormat; name: string; desc: string }[] = [
  { id: "valve_legacy", name: "Valve Legacy", desc: "Every International and Valve Major." },
  { id: "standard", name: "Standard", desc: "Events from the last ~2 years." },
];

const CARD_MODES: { id: CardMode; name: string; desc: string }[] = [
  {
    id: "career",
    name: "Career Average",
    desc: "One card per pro — stats averaged across every event, weighted by games.",
  },
  {
    id: "peak",
    name: "Peak Form",
    desc: "One card per pro — best event blended with the events around it.",
  },
  {
    id: "event",
    name: "Per Event",
    desc: "Original 322-0 style: a different card for each event a pro attended.",
  },
];

const DIFFICULTIES: { rerolls: number; name: string; desc: string }[] = [
  { rerolls: 0, name: "Hard", desc: "0 rerolls" },
  { rerolls: 1, name: "Easy", desc: "1 reroll" },
  { rerolls: 2, name: "Smurfing", desc: "2 rerolls" },
];

const ALLOCS: { id: HeroAlloc; name: string; desc: string }[] = [
  { id: "auto", name: "Automatic", desc: "Each hero is matched to the player who fits it best." },
  { id: "manual", name: "Manual", desc: "You choose which hero each player gets." },
];

export default function Home() {
  const navigate = useNavigate();
  const { config, setConfig, active, teamName, setTeamName, setPendingStart, resetRun } =
    useRunStore();

  const start = () => {
    resetRun();
    setPendingStart(true);
    navigate("/draft");
  };

  return (
    <div className="mx-auto max-w-3xl">
      {/* The plate: title engraved between hairline gold rules, like the
          name band on a cup. The one place gold lives on this screen. */}
      <div className="mx-auto mb-10 max-w-xl text-center">
        <div className="plate-rules py-4">
          <h1 className="anim-title-in plate text-6xl font-extrabold leading-none text-bone">
            El Copero
          </h1>
          <div
            className="anim-eyebrow-in plate ml-[0.4em] mt-1 text-xl text-slate-mid"
            style={{ animationDelay: "0.15s" }}
          >
            del Dota
          </div>
        </div>
        <p className="beat-in mt-3 text-sm text-slate-mid" style={{ animationDelay: "0.35s" }}>
          Draftea tu roster all-time y salí a buscar la copa.
        </p>
      </div>

      {active && (
        <button
          onClick={() => navigate("/draft")}
          className="mb-6 w-full rounded-lg border border-trophy-dim/50 py-3 text-sm font-semibold text-bone transition hover:border-trophy/60 hover:bg-ink-800"
        >
          ↳ Resume your run in progress
        </button>
      )}

      <div className="space-y-6">
        <Section label="Team Name">
          <input
            value={teamName}
            onChange={(e) => setTeamName(e.target.value)}
            maxLength={30}
            className="w-full rounded-lg border border-ink-700 bg-ink-900/40 px-4 py-3 text-base text-bone outline-none focus:border-slate-mid sm:w-72 sm:text-sm"
          />
        </Section>

        <Section label="Format">
          {FORMATS.map((f) => (
            <OptionCard
              key={f.id}
              title={f.name}
              desc={f.desc}
              selected={config.format === f.id}
              onClick={() => setConfig({ format: f.id })}
            />
          ))}
        </Section>

        <Section label="Player Cards">
          {CARD_MODES.map((m) => (
            <OptionCard
              key={m.id}
              title={m.name}
              desc={m.desc}
              selected={config.cardMode === m.id}
              onClick={() => setConfig({ cardMode: m.id })}
            />
          ))}
        </Section>

        <Section label="Difficulty">
          {DIFFICULTIES.map((d) => (
            <OptionCard
              key={d.rerolls}
              title={d.name}
              desc={d.desc}
              selected={config.rerolls === d.rerolls}
              onClick={() => setConfig({ rerolls: d.rerolls })}
            />
          ))}
        </Section>

        <Section label="Player — Hero Allocation">
          {ALLOCS.map((a) => (
            <OptionCard
              key={a.id}
              title={a.name}
              desc={a.desc}
              selected={config.heroAlloc === a.id}
              onClick={() => setConfig({ heroAlloc: a.id })}
            />
          ))}
        </Section>

        <button
          onClick={start}
          className="cta-dota cta-pulse plate w-full rounded-lg py-4 text-xl font-bold tracking-widest"
        >
          Start Run
        </button>
      </div>
    </div>
  );
}
