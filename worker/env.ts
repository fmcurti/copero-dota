import type { AuthEnv } from "./auth";
import type { CoperoDirectory } from "./directory";
import type { ProbeEnv } from "./probe";
import type { CoperoRankedQueue } from "./rankedQueue";

/** The one Worker environment — every Durable Object binding plus auth. */
export interface Env extends AuthEnv, ProbeEnv {
  CoperoRankedQueue: DurableObjectNamespace<CoperoRankedQueue>;
  CoperoDirectory: DurableObjectNamespace<CoperoDirectory>;
  ASSETS: Fetcher;
}
