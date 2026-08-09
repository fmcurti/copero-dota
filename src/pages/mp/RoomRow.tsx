import type { RoomListing } from "../../mp/directory";

const PHASE_LABEL: Record<RoomListing["phase"], string> = {
  lobby: "filling up",
  drafting: "drafting",
  assembled: "rosters locked",
  broadcasting: "TI live",
  done: "finished",
};

/**
 * One room on a browsable list. Deliberately quiet: the code is the only thing
 * wearing gold, everything else is caption-weight, so a list of eight rooms
 * reads as a list and not as eight competing headlines.
 */
export function RoomRow({
  room,
  action,
  onAction,
  live,
}: {
  room: RoomListing;
  action: string;
  onAction: () => void;
  /** Show the pulsing dot + phase label (watch list) instead of the seat count. */
  live?: boolean;
}) {
  return (
    <div className="panel flex items-center gap-4 rounded-xl px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          {live && <span className="live-dot shrink-0" />}
          <span className="plate gold-text text-xl font-bold tracking-[0.2em]">{room.code}</span>
          <span className="plate truncate text-xs tracking-widest text-slate-dim">
            {live ? PHASE_LABEL[room.phase] : `${room.seats}/${room.maxSeats} drafters`}
          </span>
        </div>
        <div className="mt-1 truncate text-xs text-slate-mid">
          {room.teams.length ? room.teams.join(" · ") : "no drafters yet"}
        </div>
      </div>

      {room.watchers > 0 && (
        <span className="plate hidden shrink-0 rounded-sm border border-ink-600 px-1.5 py-0.5 text-[10px] tracking-widest text-slate-dim sm:block">
          {room.watchers} watching
        </span>
      )}

      <button
        onClick={onAction}
        className="shrink-0 rounded-lg border border-ink-600 px-4 py-2 text-sm font-semibold text-slate-strong hover:border-slate-mid hover:text-bone"
      >
        {action}
      </button>
    </div>
  );
}
