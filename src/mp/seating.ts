import { MAX_SEATS, type Seat } from "./protocol";

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
      name,
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
