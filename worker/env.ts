import type { AuthEnv } from "./auth";
import type { CoperoDirectory } from "./directory";

/** The one Worker environment — every Durable Object binding plus auth. */
export interface Env extends AuthEnv {
  CoperoRoom: DurableObjectNamespace;
  CoperoRankedRoom: DurableObjectNamespace;
  CoperoRankedQueue: DurableObjectNamespace;
  CoperoDirectory: DurableObjectNamespace<CoperoDirectory>;
  ASSETS: Fetcher;
}
