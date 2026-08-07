// Deterministic PRNG (mulberry32) — same generator family the original uses.
// Everything downstream of a seed is reproducible, which is exactly what the
// future multiplayer server needs: share a seed, everyone sees the same sim.

export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let t = seed >>> 0;
  return () => {
    t |= 0;
    t = (t + 0x6d2b79f5) | 0;
    let n = Math.imul(t ^ (t >>> 15), 1 | t);
    n = (n + Math.imul(n ^ (n >>> 7), 61 | n)) ^ n;
    return ((n ^ (n >>> 14)) >>> 0) / 4294967296;
  };
}

/** Combine a seed with salt values into a fresh generator. */
export function seeded(seed: number, ...salts: number[]): Rng {
  let n = seed >>> 0;
  for (const s of salts) n = Math.imul(n ^ (s >>> 0), 2654435761) >>> 0;
  return mulberry32(n >>> 0);
}

/** Box–Muller gaussian. */
export function gaussian(rng: Rng, mean: number, sd: number): number {
  const u = Math.max(1e-9, rng());
  const v = rng();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function shuffle<T>(rng: Rng, arr: readonly T[]): T[] {
  const n = [...arr];
  for (let i = n.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [n[i], n[j]] = [n[j], n[i]];
  }
  return n;
}

export function pick<T>(rng: Rng, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export function randomSeed(): number {
  return Math.floor(Math.random() * 1e9);
}
