/** Dota 2 announcer clips (game audio, served from /public/audio). */
const CLIPS = {
  yourTurn: "/audio/your-turn-to-pick.mp3",
  fiveSeconds: "/audio/five-seconds.mp3",
} as const;

const VOLUME_KEY = "copero-announcer-volume";
const MUTED_KEY = "copero-announcer-muted";

const cache = new Map<keyof typeof CLIPS, HTMLAudioElement>();

function clip(name: keyof typeof CLIPS): HTMLAudioElement {
  let a = cache.get(name);
  if (!a) {
    a = new Audio(CLIPS[name]);
    a.preload = "auto";
    cache.set(name, a);
  }
  return a;
}

/** Warm the cache so the first line doesn't lag behind the moment. */
export function preloadAnnouncer() {
  for (const name of Object.keys(CLIPS) as (keyof typeof CLIPS)[]) clip(name);
}

export function getAnnouncerVolume(): number {
  const raw = localStorage.getItem(VOLUME_KEY);
  const v = raw == null ? NaN : Number(raw);
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.8;
}

export function setAnnouncerVolume(v: number) {
  localStorage.setItem(VOLUME_KEY, String(v));
}

export function getAnnouncerMuted(): boolean {
  return localStorage.getItem(MUTED_KEY) === "1";
}

export function setAnnouncerMuted(muted: boolean) {
  localStorage.setItem(MUTED_KEY, muted ? "1" : "0");
}

export function announce(name: keyof typeof CLIPS) {
  if (getAnnouncerMuted()) return;
  const a = clip(name);
  a.volume = getAnnouncerVolume();
  a.currentTime = 0;
  // Browsers block autoplay until the user first interacts — stay silent then.
  void a.play().catch(() => {});
}
