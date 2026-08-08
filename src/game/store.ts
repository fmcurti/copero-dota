import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  canPickHero,
  canPickPlayer,
  drawPack,
  emptySlots,
  isComplete,
  pickedIds,
  slotForRole,
  type DrawnPack,
  type Slots,
} from "./draft";
import { randomSeed } from "./rng";
import type { Pack, RosterPlayer, RunConfig, RunRecord } from "./types";

export const DEFAULT_CONFIG: RunConfig = {
  format: "valve_legacy",
  cardMode: "career",
  rerolls: 1,
  heroAlloc: "auto",
};

interface RunState {
  config: RunConfig;
  setConfig: (c: Partial<RunConfig>) => void;
  history: RunRecord[];
  recordRun: (r: RunRecord) => void;
  teamName: string;
  setTeamName: (n: string) => void;
  /** Victory taunts for versus — shown when you take a series off another drafter. */
  winPhrases: string[];
  setWinPhrases: (p: string[]) => void;
  pendingStart: boolean;
  setPendingStart: (v: boolean) => void;

  active: boolean;
  rerollsLeft: number;
  slots: Slots;
  heroes: number[];
  current: DrawnPack | null;
  fieldSeed: number;
  simSeed: number | null;
  heroAssign: Record<string, number>;

  setFieldSeed: (s: number) => void;
  setSimSeed: (s: number | null) => void;
  setHeroAssign: (a: Record<string, number>) => void;

  startRun: (pool: Pack[]) => void;
  draw: (pool: Pack[]) => void;
  pickPlayer: (pool: Pack[], p: RosterPlayer) => void;
  pickHero: (pool: Pack[], heroId: number) => void;
  reroll: (pool: Pack[]) => void;
  resetRun: () => void;
}

export const useRunStore = create<RunState>()(
  persist(
    (set, get) => ({
      config: DEFAULT_CONFIG,
      setConfig: (c) => set((s) => ({ config: { ...s.config, ...c } })),
      history: [],
      recordRun: (r) => set((s) => ({ history: [r, ...s.history].slice(0, 50) })),
      teamName: "Your Team",
      setTeamName: (n) => set({ teamName: n }),
      winPhrases: [],
      setWinPhrases: (p) => set({ winPhrases: p }),
      pendingStart: false,
      setPendingStart: (v) => set({ pendingStart: v }),

      active: false,
      rerollsLeft: 0,
      slots: emptySlots(),
      heroes: [],
      current: null,
      fieldSeed: randomSeed(),
      simSeed: null,
      heroAssign: {},

      setFieldSeed: (s) => set({ fieldSeed: s }),
      setSimSeed: (s) => set({ simSeed: s }),
      setHeroAssign: (a) => set({ heroAssign: a }),

      startRun: (pool) => {
        set({
          active: true,
          rerollsLeft: get().config.rerolls,
          slots: emptySlots(),
          heroes: [],
          current: null,
          fieldSeed: randomSeed(),
          simSeed: null,
          heroAssign: {},
        });
        get().draw(pool);
      },
      draw: (pool) => {
        const { slots, heroes } = get();
        const drawn = drawPack(pool, slots, heroes, Math.random);
        if (drawn) set({ current: drawn });
      },
      pickPlayer: (pool, p) => {
        const { slots, heroes } = get();
        if (!canPickPlayer(p, slots, pickedIds(slots))) return;
        const slot = slotForRole(p.role, slots);
        if (!slot) return;
        const next = { ...slots, [slot]: p };
        set({ slots: next });
        if (isComplete(next, heroes)) set({ current: null });
        else get().draw(pool);
      },
      pickHero: (pool, heroId) => {
        const { slots, heroes } = get();
        if (!canPickHero(heroId, heroes)) return;
        const next = [...heroes, heroId];
        set({ heroes: next });
        if (isComplete(slots, next)) set({ current: null });
        else get().draw(pool);
      },
      reroll: (pool) => {
        const { rerollsLeft } = get();
        if (rerollsLeft <= 0) return;
        set({ rerollsLeft: rerollsLeft - 1 });
        get().draw(pool);
      },
      resetRun: () =>
        set({
          active: false,
          current: null,
          slots: emptySlots(),
          heroes: [],
          simSeed: null,
          heroAssign: {},
        }),
    }),
    { name: "322-versus-run" },
  ),
);
