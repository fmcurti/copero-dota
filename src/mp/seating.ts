import { MAX_SEATS, NAME_MAX, type Seat } from "./protocol";

// Boards are read at a glance during a draft, so two teams sharing a name is
// worse than a clumsy name: comparison ignores case, since "Alianza" and
// "alianza" are the same team to everyone watching.
const fold = (name: string) => name.trim().toLowerCase();

/** Is another seat already using this name? */
export function nameTaken(seats: Seat[], name: string, exceptPlayerId?: string): boolean {
  const wanted = fold(name);
  return seats.some((seat) => seat.playerId !== exceptPlayerId && fold(seat.name) === wanted);
}

/**
 * The first free variant of `name` — "Alianza", then "Alianza 2", "Alianza 3"…
 * Used when someone arrives with a name rather than choosing one, where an
 * error would just be a dead end.
 */
export function uniqueName(seats: Seat[], name: string, exceptPlayerId?: string): string {
  if (!nameTaken(seats, name, exceptPlayerId)) return name;
  for (let n = 2; n <= MAX_SEATS + 1; n++) {
    const suffix = ` ${n}`;
    const candidate = name.slice(0, NAME_MAX - suffix.length) + suffix;
    if (!nameTaken(seats, candidate, exceptPlayerId)) return candidate;
  }
  return name; // unreachable with at most MAX_SEATS seats
}

/** Add or reconnect a drafter without disturbing the established seat order. */
export function seatPlayer(
  seats: Seat[],
  playerId: string,
  name: string,
  maxSeats = MAX_SEATS,
): Seat[] {
  const existing = seats.findIndex((seat) => seat.playerId === playerId);
  if (existing >= 0) {
    return seats.map((seat, index) =>
      index === existing ? { ...seat, connected: true } : seat,
    );
  }
  if (seats.length >= maxSeats) return seats;
  return [
    ...seats,
    {
      playerId,
      // Arriving with a name someone already took is nobody's fault — everyone
      // shares one default — so disambiguate rather than refuse the seat.
      name: uniqueName(seats, name),
      connected: true,
      isHost: seats.length === 0,
    },
  ];
}

/** Vacate a lobby seat and hand hosting to the first remaining drafter. */
export function unseatPlayer(seats: Seat[], playerId: string): Seat[] {
  const removed = seats.find((seat) => seat.playerId === playerId);
  if (!removed) return seats;

  const remaining = seats.filter((seat) => seat.playerId !== playerId);
  if (!removed.isHost || remaining.length === 0) return remaining;
  return remaining.map((seat, index) => ({ ...seat, isHost: index === 0 }));
}
