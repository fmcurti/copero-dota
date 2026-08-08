import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Section } from "../../components/options";
import { useRunStore } from "../../game/store";
import {
  MAX_WIN_PHRASES,
  MAX_WIN_PHRASE_LEN,
  makeRoomCode,
  sanitizeWinPhrases,
} from "../../mp/protocol";

/** Optional victory taunts: shown (at random) when you beat another drafter. */
function WinPhrasesEditor() {
  const { winPhrases, setWinPhrases } = useRunStore();
  const [draft, setDraft] = useState("");

  const add = () => {
    const next = sanitizeWinPhrases([...winPhrases, draft]);
    if (next.length > winPhrases.length) setDraft("");
    setWinPhrases(next);
  };
  const remove = (idx: number) => setWinPhrases(winPhrases.filter((_, i) => i !== idx));

  return (
    <div className="w-full space-y-2">
      {winPhrases.length > 0 && (
        <div className="space-y-1.5">
          {winPhrases.map((phrase, i) => (
            <div
              key={`${i}-${phrase}`}
              className="flex items-center gap-2 rounded-lg border border-ink-700 bg-ink-900/40 px-3 py-2"
            >
              <span className="plate-italic min-w-0 flex-1 truncate text-sm text-slate-strong">
                “{phrase}”
              </span>
              <button
                onClick={() => remove(i)}
                title="Delete phrase"
                className="shrink-0 rounded border border-ink-700 px-1.5 text-xs text-slate-dim transition hover:border-dire-dim hover:text-dire"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      {winPhrases.length < MAX_WIN_PHRASES ? (
        <div className="flex w-full gap-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
            placeholder="ez game, ez life…"
            maxLength={MAX_WIN_PHRASE_LEN}
            className="min-w-0 flex-1 rounded-lg border border-ink-700 bg-ink-900/40 px-4 py-2.5 text-sm text-bone outline-none focus:border-slate-mid"
          />
          <button
            onClick={add}
            disabled={!draft.trim()}
            className="rounded-lg border border-ink-600 px-4 text-sm font-semibold text-slate-strong transition hover:border-slate-mid hover:text-bone disabled:cursor-not-allowed disabled:opacity-40"
          >
            Add
          </button>
        </div>
      ) : (
        <div className="text-xs text-slate-dim">{MAX_WIN_PHRASES} frases — arsenal completo.</div>
      )}
      <p className="text-xs text-slate-dim">
        cuando le ganás una serie a otro drafter, una frase tuya (al azar) aparece en pantalla
        para todos
      </p>
    </div>
  );
}

export default function Versus() {
  const navigate = useNavigate();
  const { teamName, setTeamName } = useRunStore();
  const [joinCode, setJoinCode] = useState("");

  const join = () => {
    const code = joinCode.trim().toUpperCase();
    if (code.length >= 4) navigate(`/mp/${code}`);
  };

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mx-auto mb-10 max-w-xl text-center">
        <div className="plate-rules py-4">
          <h1 className="anim-title-in plate text-5xl font-extrabold leading-none text-bone">
            Versus
          </h1>
          <div
            className="anim-eyebrow-in plate ml-[0.4em] mt-1 text-lg text-slate-mid"
            style={{ animationDelay: "0.15s" }}
          >
            2–8 drafters
          </div>
        </div>
        <p className="beat-in mt-3 text-sm text-slate-mid" style={{ animationDelay: "0.35s" }}>
          Un solo Copero. Packs compartidos, players exclusivos, una simulación para todos.
        </p>
      </div>

      <div className="space-y-6">
        <Section label="Your Team Name">
          <input
            value={teamName}
            onChange={(e) => setTeamName(e.target.value)}
            maxLength={30}
            className="w-full rounded-lg border border-ink-700 bg-ink-900/40 px-4 py-3 text-sm text-bone outline-none focus:border-slate-mid sm:w-72"
          />
        </Section>

        <Section label="Win Phrases — optional">
          <WinPhrasesEditor />
        </Section>

        <Section label="Create">
          <button
            onClick={() => navigate(`/mp/${makeRoomCode()}`)}
            className="cta-dota plate w-full rounded-lg py-4 text-lg font-bold tracking-widest sm:w-72"
          >
            Create Lobby
          </button>
        </Section>

        <Section label="Join">
          <div className="flex w-full gap-2 sm:w-72">
            <input
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
              onKeyDown={(e) => e.key === "Enter" && join()}
              placeholder="ROOM CODE"
              maxLength={5}
              className="plate min-w-0 flex-1 rounded-lg border border-ink-700 bg-ink-900/40 px-4 py-3 text-center text-lg tracking-[0.3em] text-bone outline-none focus:border-slate-mid"
            />
            <button
              onClick={join}
              disabled={joinCode.trim().length < 4}
              className="rounded-lg border border-ink-600 px-5 text-sm font-semibold text-slate-strong hover:border-slate-mid hover:text-bone disabled:cursor-not-allowed disabled:opacity-40"
            >
              Join
            </button>
          </div>
        </Section>
      </div>
    </div>
  );
}
