// Shared between the directory and the rooms it probes. Worker-only: nothing
// under src/ imports this file, so the token never reaches the client bundle.

/** The one directory object. Rooms publish into it; /api/rooms reads it. */
export const DIRECTORY_ID = "global";

export const PROBE_PATH = "/__directory/probe";
export const PROBE_HEADER = "x-copero-probe";
/**
 * Not a secret in the cryptographic sense — it is a second lock behind the
 * edge guard in index.ts, so that a stray request can never make a room
 * describe itself.
 */
export const PROBE_TOKEN = "copero-directory-probe-9f2c";

/** A probe reaches the room over fetch(), so it needs an absolute URL. */
export const PROBE_URL = `https://copero.internal${PROBE_PATH}`;

export interface ProbeEnv {
  CoperoRoom: DurableObjectNamespace;
  CoperoRankedRoom: DurableObjectNamespace;
}
