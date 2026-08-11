import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Section } from "../../components/options";
import { useRunStore } from "../../game/store";
import { directoryView } from "../../mp/directory";
import { makeRoomCode } from "../../mp/protocol";
import { RoomRow } from "./RoomRow";
import { useRooms } from "./useRooms";

export default function Versus() {
  const navigate = useNavigate();
  const { teamName, setTeamName } = useRunStore();
  const [joinCode, setJoinCode] = useState("");
  const { rooms, now, loaded } = useRooms();
  const { openLobbies: open, liveGames: live } = directoryView(rooms, now());

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

      {/* One narrow centered column under the centered title — the controls
          share its full width so nothing hugs the page's left edge. */}
      <div className="mx-auto max-w-sm space-y-6">
        <Section label="Your Team Name">
          <input
            value={teamName}
            onChange={(e) => setTeamName(e.target.value)}
            maxLength={30}
            className="w-full rounded-lg border border-ink-700 bg-ink-900/40 px-4 py-3 text-sm text-bone outline-none focus:border-slate-mid"
          />
        </Section>

        <Section label="Create">
          <button
            onClick={() => navigate(`/mp/${makeRoomCode()}`)}
            className="cta-dota plate w-full rounded-lg py-4 text-lg font-bold tracking-widest"
          >
            Create Lobby
          </button>
        </Section>

        <Section label="Join">
          <div className="flex w-full gap-2">
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

      {/* Wider than the form column (rows carry more text) but centered with it. */}
      <div className="mx-auto mt-10 max-w-xl">
        <Section label="Open lobbies">
          <div className="w-full space-y-2 text-center">
            {open.length ? (
              open.map((room) => (
                <RoomRow
                  key={room.code}
                  room={room}
                  action="Join"
                  onAction={() => navigate(`/mp/${room.code}`)}
                />
              ))
            ) : (
              <p className="text-sm text-slate-dim">
                {loaded
                  ? "No public lobbies right now. Create one and set it to Public."
                  : "Looking for lobbies…"}
              </p>
            )}
            {live.length > 0 && (
              <Link
                to="/watch"
                className="plate inline-block pt-2 text-xs tracking-widest text-slate-mid hover:text-bone"
              >
                {live.length} {live.length === 1 ? "game" : "games"} live · watch →
              </Link>
            )}
          </div>
        </Section>
      </div>
    </div>
  );
}
