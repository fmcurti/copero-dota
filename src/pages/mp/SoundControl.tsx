import { useState } from "react";
import {
  announce,
  getAnnouncerMuted,
  getAnnouncerVolume,
  setAnnouncerMuted,
  setAnnouncerVolume,
} from "./announcer";

function SpeakerIcon({ muted }: { muted: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden>
      {muted ? (
        <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4 9.91 6.09 12 8.18V4z" />
      ) : (
        <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
      )}
    </svg>
  );
}

/** Announcer mute + volume, persisted per browser. */
export function SoundControl() {
  const [muted, setMuted] = useState(getAnnouncerMuted);
  const [volume, setVolume] = useState(getAnnouncerVolume);
  return (
    <div className="flex items-center gap-1.5">
      <button
        onClick={() => {
          setAnnouncerMuted(!muted);
          setMuted(!muted);
        }}
        title={muted ? "Unmute announcer" : "Mute announcer"}
        className={`cursor-pointer transition-colors ${muted ? "text-slate-dim" : "text-slate-strong hover:text-bone"}`}
      >
        <SpeakerIcon muted={muted} />
      </button>
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={volume}
        onChange={(e) => {
          const v = Number(e.target.value);
          setAnnouncerVolume(v);
          setVolume(v);
        }}
        onPointerUp={() => announce("fiveSeconds")}
        title="Announcer volume"
        className={`h-1 w-20 cursor-pointer accent-dire ${muted ? "opacity-40" : ""}`}
      />
    </div>
  );
}
