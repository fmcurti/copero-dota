export interface ServerClockSample {
  /** Server epoch milliseconds when it handled the probe. */
  serverNow: number;
  /** Local monotonic milliseconds immediately before sending the probe. */
  sentAt: number;
  /** Local monotonic milliseconds immediately after receiving the reply. */
  receivedAt: number;
}

/**
 * Map a server timestamp to the instant its reply reached this client.
 * Half the round trip approximates the outbound half of the network delay.
 */
export function serverAtReceipt(sample: ServerClockSample): number {
  return sample.serverNow + Math.max(0, sample.receivedAt - sample.sentAt) / 2;
}

/**
 * A server-epoch clock driven by a local monotonic clock. Device wall-clock
 * skew and later OS clock corrections therefore cannot move a countdown.
 */
export class ServerClock {
  private serverAtAnchor: number | null = null;
  private monotonicAtAnchor = 0;
  private listeners = new Set<() => void>();

  constructor(private readonly monotonicNow: () => number) {}

  now(): number | null {
    if (this.serverAtAnchor == null) return null;
    return this.serverAtAnchor + (this.monotonicNow() - this.monotonicAtAnchor);
  }

  /** Use the least-delayed probe; queued/slow samples have the most error. */
  applySamples(samples: ServerClockSample[]): boolean {
    const best = samples
      .filter((sample) => sample.receivedAt >= sample.sentAt)
      .sort((a, b) => a.receivedAt - a.sentAt - (b.receivedAt - b.sentAt))[0];
    if (!best) return false;

    this.serverAtAnchor = serverAtReceipt(best);
    this.monotonicAtAnchor = best.receivedAt;
    this.listeners.forEach((listener) => listener());
    return true;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const serverClock = new ServerClock(() => performance.now());

const PROBE_COUNT = 3;
let inFlight: Promise<boolean> | null = null;

async function probeServerClock(): Promise<ServerClockSample | null> {
  const sentAt = performance.now();
  try {
    const response = await fetch("/api/time", {
      cache: "no-store",
      headers: { accept: "application/json" },
    });
    const json = (await response.json()) as { now?: unknown };
    const receivedAt = performance.now();
    if (!response.ok || typeof json.now !== "number" || !Number.isSafeInteger(json.now)) {
      return null;
    }
    return { serverNow: json.now, sentAt, receivedAt };
  } catch {
    return null;
  }
}

/** Coalesced so every mounted countdown can safely request synchronization. */
export function synchronizeServerClock(): Promise<boolean> {
  if (inFlight) return inFlight;
  inFlight = Promise.all(Array.from({ length: PROBE_COUNT }, () => probeServerClock()))
    .then((samples) => serverClock.applySamples(samples.filter((sample) => sample !== null)))
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}
