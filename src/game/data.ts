import { useEffect, useMemo, useState } from "react";
import type { DataBundle, Hero } from "./types";

import { fetchBundle } from "./bundle";

const browserFetch = async (name: string): Promise<unknown> => {
  const res = await fetch(`/data/${name}`, { cache: "no-cache" });
  if (!res.ok) throw new Error(`Failed to load ${name}: ${res.status}`);
  return res.json();
};

let bundlePromise: Promise<DataBundle> | null = null;

export function loadBundle(): Promise<DataBundle> {
  bundlePromise ??= fetchBundle(browserFetch);
  return bundlePromise;
}

export function useBundle(): { bundle: DataBundle | null; error: string | null } {
  const [bundle, setBundle] = useState<DataBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    loadBundle()
      .then((b) => alive && setBundle(b))
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, []);
  return { bundle, error };
}

export function useHeroById(bundle: DataBundle | null): Map<number, Hero> {
  return useMemo(() => new Map((bundle?.heroes ?? []).map((h) => [h.id, h])), [bundle]);
}

export function heroImage(picture: string | undefined): string {
  return picture ? `https://cdn.datdota.com/images/heroes/${picture}_full.png` : "";
}

export function eventShortName(bundle: DataBundle | null, eventId: string | null): string {
  if (!bundle || !eventId) return "";
  return bundle.events.find((e) => e.id === eventId)?.short ?? "";
}
