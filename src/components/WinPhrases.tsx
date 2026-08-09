import { useState } from "react";
import { useRunStore } from "../game/store";
import { MAX_WIN_PHRASES, MAX_WIN_PHRASE_LEN, sanitizeWinPhrases } from "../mp/protocol";

/**
 * Victory-taunt editor. Phrases persist in the run store; while seated in a
 * room, Room.tsx watches the store and syncs them to your seat, so edits made
 * in the lobby land immediately.
 */
export function WinPhrasesEditor() {
  const { winPhrases, setWinPhrases } = useRunStore();
  const [draft, setDraft] = useState("");
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editText, setEditText] = useState("");

  const add = () => {
    const next = sanitizeWinPhrases([...winPhrases, draft]);
    if (next.length > winPhrases.length) setDraft("");
    setWinPhrases(next);
  };
  const remove = (idx: number) => setWinPhrases(winPhrases.filter((_, i) => i !== idx));
  const startEdit = (idx: number) => {
    setEditingIdx(idx);
    setEditText(winPhrases[idx]);
  };
  const commitEdit = () => {
    if (editingIdx == null) return;
    const next = sanitizeWinPhrases(winPhrases.map((p, i) => (i === editingIdx ? editText : p)));
    // An emptied phrase would vanish in sanitize — treat that as "cancel", not delete.
    if (next.length === winPhrases.length) setWinPhrases(next);
    setEditingIdx(null);
  };

  return (
    <div className="w-full space-y-2">
      {winPhrases.length > 0 && (
        <div className="space-y-1.5">
          {winPhrases.map((phrase, i) =>
            editingIdx === i ? (
              // The input takes the row's exact geometry, so focus lights the
              // whole box's border gold — same feel as the "add" input below.
              <input
                key={`edit-${i}`}
                autoFocus
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                onBlur={commitEdit}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitEdit();
                  else if (e.key === "Escape") setEditingIdx(null);
                }}
                maxLength={MAX_WIN_PHRASE_LEN}
                className="plate-italic w-full rounded-lg border border-ink-700 bg-ink-900/40 px-3 py-2 text-sm normal-case text-bone outline-none"
              />
            ) : (
              <div
                key={`${i}-${phrase}`}
                className="flex items-center gap-2 rounded-lg border border-ink-700 bg-ink-900/40 px-3 py-2"
              >
                <span
                  onClick={() => startEdit(i)}
                  title="Click to edit"
                  className="plate-italic min-w-0 flex-1 cursor-pointer truncate text-sm normal-case text-slate-strong transition-colors hover:text-bone"
                >
                  {phrase}
                </span>
                <button
                  onClick={() => remove(i)}
                  title="Delete phrase"
                  className="shrink-0 rounded border border-ink-700 px-1.5 text-xs text-slate-dim transition hover:border-dire-dim hover:text-dire"
                >
                  ✕
                </button>
              </div>
            ),
          )}
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
