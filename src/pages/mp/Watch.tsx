import { useNavigate } from "react-router-dom";
import { liveGames } from "../../mp/directory";
import { RoomRow } from "./RoomRow";
import { watchOnly } from "./useRoom";
import { useRooms } from "./useRooms";

export default function Watch() {
  const navigate = useNavigate();
  const { rooms, now, loaded, error } = useRooms();
  const live = liveGames(rooms, now());

  const watch = (code: string) => {
    // Claim a viewer's seat-less connection before the room page mounts —
    // useRoom reads this once, when it opens the socket.
    watchOnly(code);
    navigate(`/mp/${code}`);
  };

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mx-auto mb-10 max-w-xl text-center">
        <div className="plate-rules py-4">
          <h1 className="anim-title-in plate text-5xl font-extrabold leading-none text-bone">
            Watch
          </h1>
          <div
            className="anim-eyebrow-in plate ml-[0.4em] mt-1 text-lg text-slate-mid"
            style={{ animationDelay: "0.15s" }}
          >
            live drafts
          </div>
        </div>
        <p className="beat-in mt-3 text-sm text-slate-mid" style={{ animationDelay: "0.35s" }}>
          Public and spectatable rooms. You see everything: packs, boards, chemistry.
        </p>
      </div>

      {error ? (
        <p className="text-center text-sm text-dire">Could not read the room list.</p>
      ) : live.length ? (
        <div className="space-y-2">
          {live.map((room) => (
            <RoomRow key={room.code} room={room} action="Watch" onAction={() => watch(room.code)} live />
          ))}
        </div>
      ) : (
        <p className="text-center text-sm text-slate-dim">
          {loaded ? "Nothing live right now." : "Looking for live drafts…"}
        </p>
      )}
    </div>
  );
}
