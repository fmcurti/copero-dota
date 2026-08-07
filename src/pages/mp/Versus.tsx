import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Section } from "../../components/options";
import { useRunStore } from "../../game/store";
import { makeRoomCode } from "../../mp/protocol";

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
          <h1 className="plate text-5xl font-extrabold leading-none text-bone">Versus</h1>
          <div className="plate ml-[0.5em] mt-1 text-lg tracking-[0.5em] text-slate-mid">
            2–4 drafters
          </div>
        </div>
        <p className="mt-3 text-sm text-slate-mid">
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

        <Section label="Create">
          <button
            onClick={() => navigate(`/mp/${makeRoomCode()}`)}
            className="plate w-full rounded-lg bg-bone py-4 text-lg font-bold tracking-widest text-ink-950 transition hover:bg-white sm:w-72"
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
