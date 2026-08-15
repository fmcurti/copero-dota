import { describe, expect, it, vi } from "vitest";
import { ServerClock, serverAtReceipt } from "./serverClock";

describe("server clock", () => {
  it("compensates for the outbound half of round-trip latency", () => {
    expect(
      serverAtReceipt({ serverNow: 1_000_000, sentAt: 100, receivedAt: 180 }),
    ).toBe(1_000_040);
  });

  it("counts from server time without consulting a skewed device wall clock", () => {
    let monotonicNow = 200;
    const clock = new ServerClock(() => monotonicNow);
    clock.applySamples([{ serverNow: 1_000_000, sentAt: 100, receivedAt: 200 }]);

    const deadline = 1_000_050 + 15_000;
    // These offsets reproduce the observed 13/17/100 values under the old
    // wall-clock calculation. None affects the synchronized calculation.
    for (const { wallClockOffset, oldDisplay } of [
      { wallClockOffset: 2_000, oldDisplay: 13 },
      { wallClockOffset: -2_000, oldDisplay: 17 },
      { wallClockOffset: -85_000, oldDisplay: 100 },
    ]) {
      expect(Math.ceil((deadline - (clock.now()! + wallClockOffset)) / 1000)).toBe(oldDisplay);
      expect(Math.ceil((deadline - clock.now()!) / 1000)).toBe(15);
    }

    monotonicNow += 5_000;
    expect(Math.ceil((deadline - clock.now()!) / 1000)).toBe(10);
  });

  it("uses the lowest-RTT sample and notifies subscribers", () => {
    let monotonicNow = 500;
    const clock = new ServerClock(() => monotonicNow);
    const listener = vi.fn();
    clock.subscribe(listener);

    expect(
      clock.applySamples([
        { serverNow: 10_000, sentAt: 0, receivedAt: 400 },
        { serverNow: 10_200, sentAt: 450, receivedAt: 500 },
      ]),
    ).toBe(true);
    expect(clock.now()).toBe(10_225);
    expect(listener).toHaveBeenCalledOnce();

    monotonicNow = 1_000;
    expect(clock.now()).toBe(10_725);
  });
});
