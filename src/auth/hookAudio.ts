// Foley for the sign-out hook, synthesized from scratch — filtered noise for
// the whooshes, detuned inharmonic partials for metal — so the moment needs no
// audio assets. Born inside the click that opened the modal, which is what
// autoplay policy requires. Every method is fire-and-forget and swallows its
// own errors: sound is garnish, never a reason the hook fails to fly.

export interface HookAudio {
  /** Chain rattle + rising whoosh: the hook leaves the machine. */
  throwWhoosh(): void;
  /** The chain lets the plate go and slithers home. */
  release(): void;
  /** The confirm yank: a whip crack of chain leaving fast. */
  yank(): void;
  dispose(): void;
}

const NOOP: HookAudio = {
  throwWhoosh() {},
  release() {},
  yank() {},
  dispose() {},
};

export function createHookAudio(): HookAudio {
  const Ctor =
    window.AudioContext ??
    (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return NOOP;

  let ctx: AudioContext;
  try {
    ctx = new Ctor();
  } catch {
    return NOOP;
  }

  const master = ctx.createGain();
  master.gain.value = 0.35;
  master.connect(ctx.destination);

  const noiseBuffer = (() => {
    const buffer = ctx.createBuffer(1, ctx.sampleRate * 1.5, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  })();

  const noise = () => {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    return src;
  };

  /** Bandpass-swept noise: the air the chain cuts through. */
  const whoosh = (from: number, to: number, dur: number, peak: number, at = 0) => {
    const t0 = ctx.currentTime + at;
    const src = noise();
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.Q.value = 0.85;
    filter.frequency.setValueAtTime(from, t0);
    filter.frequency.exponentialRampToValueAtTime(Math.max(to, 40), t0 + dur);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(peak, t0 + dur * 0.35);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(filter).connect(gain).connect(master);
    src.start(t0);
    src.stop(t0 + dur + 0.05);
  };

  /** A burst of tiny high metallic ticks: links slapping each other. */
  const rattle = (dur: number, ticks: number, loud = 0.08, at = 0) => {
    for (let i = 0; i < ticks; i++) {
      const t0 = ctx.currentTime + at + (i / ticks) * dur + Math.random() * 0.02;
      const src = noise();
      const filter = ctx.createBiquadFilter();
      filter.type = "highpass";
      filter.frequency.value = 2600 + Math.random() * 1800;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(loud * (0.5 + Math.random() * 0.5), t0);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.03);
      src.connect(filter).connect(gain).connect(master);
      src.start(t0, Math.random(), 0.05);
    }
  };

  /** Struck metal: inharmonic partials over a dead thud. */
  const clangAt = (base: number, loud: number, at = 0) => {
    const t0 = ctx.currentTime + at;
    const ratios = [1, 2.32, 3.01, 4.27, 5.68, 7.4];
    const gains = [0.42, 0.28, 0.22, 0.15, 0.11, 0.07];
    ratios.forEach((ratio, i) => {
      const osc = ctx.createOscillator();
      osc.frequency.value = base * ratio * (1 + (Math.random() - 0.5) * 0.01);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(gains[i] * loud, t0);
      gain.gain.setTargetAtTime(0.0001, t0 + 0.005, 0.1 + 0.35 / (i + 1));
      osc.connect(gain).connect(master);
      osc.start(t0);
      osc.stop(t0 + 1.4);
    });
    const thud = ctx.createOscillator();
    thud.frequency.setValueAtTime(95, t0);
    thud.frequency.exponentialRampToValueAtTime(45, t0 + 0.12);
    const thudGain = ctx.createGain();
    thudGain.gain.setValueAtTime(0.5 * loud, t0);
    thudGain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.16);
    thud.connect(thudGain).connect(master);
    thud.start(t0);
    thud.stop(t0 + 0.2);
    const burst = noise();
    const highpass = ctx.createBiquadFilter();
    highpass.type = "highpass";
    highpass.frequency.value = 1800;
    const burstGain = ctx.createGain();
    burstGain.gain.setValueAtTime(0.3 * loud, t0);
    burstGain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.07);
    burst.connect(highpass).connect(burstGain).connect(master);
    burst.start(t0, Math.random(), 0.1);
  };

  const guarded = (fn: () => void) => () => {
    try {
      if (ctx.state === "suspended") void ctx.resume();
      fn();
    } catch {
      // sound stays optional
    }
  };

  return {
    throwWhoosh: guarded(() => {
      whoosh(350, 2400, 0.4, 0.5);
      rattle(0.4, 10);
    }),
    release: guarded(() => {
      whoosh(2100, 260, 0.5, 0.32);
      rattle(0.32, 8, 0.06);
    }),
    yank: guarded(() => {
      whoosh(260, 2800, 0.3, 0.55);
      rattle(0.26, 7);
      clangAt(230, 0.35, 0.05);
    }),
    dispose() {
      void ctx.close().catch(() => undefined);
    },
  };
}
