import type { AuthEnv } from "./auth";
import type { CoperoDirectory } from "./directory";
import type { ProbeEnv } from "./probe";

/** The one Worker environment — every Durable Object binding plus auth. */
export interface Env extends AuthEnv, ProbeEnv {
  CoperoRankedQueue: DurableObjectNamespace;
  CoperoDirectory: DurableObjectNamespace<CoperoDirectory>;
  ASSETS: Fetcher;
}
