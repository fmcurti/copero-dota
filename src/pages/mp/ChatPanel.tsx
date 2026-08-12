import { useEffect, useRef, useState } from "react";
import { MAX_CHAT_LEN, type ChatEntry, type ClientMsg } from "../../mp/protocol";

/**
 * The room's message log. Docked it fills its parent (the draft rail);
 * floating it sits bottom-right, collapsed to a pill with an unread badge.
 */
export function ChatPanel({
  chat,
  myId,
  canChat,
  send,
  docked = false,
}: {
  chat: ChatEntry[];
  myId: string | null;
  canChat: boolean;
  send: (m: ClientMsg) => void;
  docked?: boolean;
}) {
  const [open, setOpen] = useState(docked);
  const [lastSeenSeq, setLastSeenSeq] = useState(0);
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  const lastSeq = chat.at(-1)?.seq ?? 0;
  useEffect(() => {
    if (!open) return;
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setLastSeenSeq(lastSeq);
  }, [open, lastSeq]);

  if (!docked && !open) {
    const unread = chat.filter((m) => m.seq > lastSeenSeq).length;
    return (
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-4 right-4 z-40 rounded-full border border-ink-600 bg-ink-950/95 px-4 py-2 text-sm font-semibold text-slate-strong shadow-lg hover:border-slate-mid hover:text-bone"
      >
        Chat
        {unread > 0 && (
          <span className="ml-2 rounded-full bg-dire px-1.5 text-xs font-bold text-bone">
            {unread}
          </span>
        )}
      </button>
    );
  }

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    send({ t: "chat", text });
    // Clear optimistically — the message shows up when the snapshot echoes.
    setDraft("");
  };

  const panel = (
    <div
      className={`rounded-lg border border-ink-700 p-2 ${
        docked ? "bg-ink-900/40" : "w-72 bg-ink-950/95 shadow-lg"
      }`}
    >
      <div className="flex items-center justify-between px-1 pb-1">
        <span className="plate text-sm tracking-widest text-slate-dim">Chat</span>
        {!docked && (
          <button
            onClick={() => setOpen(false)}
            className="text-xs text-slate-dim hover:text-bone"
            aria-label="Collapse chat"
          >
            ✕
          </button>
        )}
      </div>
      <div ref={listRef} className="max-h-64 space-y-1 overflow-y-auto px-1 text-sm">
        {chat.length === 0 && (
          <div className="py-2 text-center text-xs text-slate-dim">No messages yet.</div>
        )}
        {chat.map((m) => (
          <div key={m.seq} className="break-words leading-snug">
            <span
              className={`font-bold ${m.playerId === myId ? "text-bone" : "text-slate-strong"}`}
            >
              {m.name}
            </span>{" "}
            <span className="text-slate-mid">{m.text}</span>
          </div>
        ))}
      </div>
      {canChat ? (
        <form
          className="mt-2 flex gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={MAX_CHAT_LEN}
            placeholder="Say something…"
            className="min-w-0 flex-1 rounded-md border border-ink-700 bg-ink-950 px-2 py-1 text-sm text-bone placeholder:text-slate-dim focus:border-slate-mid focus:outline-none"
          />
          <button
            type="submit"
            className="rounded-md border border-ink-600 px-2 py-1 text-xs font-semibold text-slate-strong hover:border-slate-mid hover:text-bone"
          >
            Send
          </button>
        </form>
      ) : (
        <div className="mt-2 px-1 text-center text-[11px] tracking-widest text-slate-dim">
          Spectating · read only
        </div>
      )}
    </div>
  );

  return docked ? panel : <div className="fixed bottom-4 right-4 z-40">{panel}</div>;
}
