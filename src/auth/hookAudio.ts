// The modal uses the real Dota 2 Meat Hook samples packaged under
// /public/audio. Audio is garnish: playback failures are swallowed and never
// prevent the modal animation or its actions from completing.

export interface HookAudio {
  /** Meat Hook's chain starts extending. */
  throwWhoosh(): void;
  /** Meat Hook catches the plate. */
  impact(): void;
  /** The chain reaches the end of a retract. */
  retractStop(): void;
  /** The hook releases the plate and retracts by itself. */
  release(): void;
  /** The hook retracts quickly with the plate attached. */
  yank(): void;
  dispose(): void;
}

const CLIPS = {
  chain: "/audio/pudge-hook-throw.mp3",
  impact: "/audio/pudge-hook-impact.mp3",
  retractStop: "/audio/pudge-hook-retract-stop.mp3",
} as const;

const RELEASE_MS = 260;
const YANK_MS = 320;

const NOOP: HookAudio = {
  throwWhoosh() {},
  impact() {},
  retractStop() {},
  release() {},
  yank() {},
  dispose() {},
};

export function createHookAudio(): HookAudio {
  if (typeof Audio === "undefined") return NOOP;

  let chain: HTMLAudioElement;
  let impact: HTMLAudioElement;
  let retractStop: HTMLAudioElement;
  try {
    chain = new Audio(CLIPS.chain);
    impact = new Audio(CLIPS.impact);
    retractStop = new Audio(CLIPS.retractStop);
  } catch {
    return NOOP;
  }

  const clips = [chain, impact, retractStop];
  for (const clip of clips) {
    clip.preload = "auto";
    clip.volume = 0.05;
  }
  impact.volume = 0.07;

  const timers = new Set<number>();
  let disposed = false;

  const play = (clip: HTMLAudioElement, restart = true) => {
    if (disposed) return;
    try {
      if (restart) clip.currentTime = 0;
      void clip.play().catch(() => undefined);
    } catch {
      // Browsers may still decline playback despite the opening click.
    }
  };

  const stopChain = () => {
    try {
      chain.pause();
      chain.currentTime = 0;
    } catch {
      // Sound must never become a modal failure mode.
    }
  };

  const finishRetract = () => {
    stopChain();
    play(retractStop);
  };

  const scheduledRetract = (delay: number) => {
    stopChain();
    play(chain);
    const timer = window.setTimeout(() => {
      timers.delete(timer);
      finishRetract();
    }, delay);
    timers.add(timer);
  };

  return {
    throwWhoosh: () => play(chain),
    impact: () => play(impact),
    retractStop: finishRetract,
    release: () => scheduledRetract(RELEASE_MS),
    yank: () => scheduledRetract(YANK_MS),
    dispose() {
      disposed = true;
      for (const timer of timers) window.clearTimeout(timer);
      timers.clear();
      for (const clip of clips) {
        try {
          clip.pause();
          clip.removeAttribute("src");
          clip.load();
        } catch {
          // Best-effort cleanup only.
        }
      }
    },
  };
}
