import { routePartykitRequest } from "partyserver";
import { authCapabilities, getUser, handleAuth } from "./auth";
import { CoperoDirectory } from "./directory";
import type { Env } from "./env";
import { DIRECTORY_ID } from "./probe";
import { handleRankedApi } from "./rankedApi";
import { CoperoRankedQueue } from "./rankedQueue";
import { CoperoRankedRoom, IDENTITY_ID_HEADER, IDENTITY_NAME_HEADER } from "./rankedRoom";
import { CoperoRoom } from "./room";

export { CoperoDirectory, CoperoRankedQueue, CoperoRankedRoom, CoperoRoom };

const RANKED_QUEUE_PATH = "/parties/copero-ranked-queue/main";
const RANKED_ROOM_PREFIX = "/parties/copero-ranked-room/";

/**
 * Stamp the verified session identity onto a ranked upgrade — and strip
 * whatever a client put under those names. The internal headers are the only
 * identity the ranked Durable Objects trust.
 */
function withIdentity(
  request: Request,
  user: { id: string; name: string } | null,
): Request {
  const headers = new Headers(request.headers);
  headers.delete(IDENTITY_ID_HEADER);
  headers.delete(IDENTITY_NAME_HEADER);
  if (user) {
    headers.set(IDENTITY_ID_HEADER, user.id);
    headers.set(IDENTITY_NAME_HEADER, encodeURIComponent(user.name));
  }
  return new Request(request, { headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/auth/")) {
      return handleAuth(request, env);
    }

    if (url.pathname === "/api/auth-config") {
      return Response.json(await authCapabilities(env), {
        headers: { "cache-control": "no-store" },
      });
    }

    if (url.pathname === "/api/rooms") {
      const ns = env.CoperoDirectory;
      const data = await ns.get(ns.idFromName(DIRECTORY_ID)).list();
      return Response.json(data, { headers: { "cache-control": "no-store" } });
    }

    const ranked = await handleRankedApi(request, env);
    if (ranked) return ranked;

    // routePartykitRequest routes EVERY Durable Object binding by kebab-cased
    // name, so the directory and the rooms' internal endpoints (probe, ranked
    // init/release) would all be reachable from the internet. Rooms and the
    // queue take websockets and nothing else; the directory takes nothing.
    if (url.pathname.startsWith("/parties/")) {
      const isWebSocket = request.headers.get("Upgrade")?.toLowerCase() === "websocket";
      if (!isWebSocket || url.pathname.startsWith("/parties/copero-directory/")) {
        return new Response("Not found", { status: 404 });
      }
      if (url.pathname.startsWith("/parties/copero-ranked-queue/")) {
        // One global queue — arbitrary names would silently shard it.
        if (url.pathname !== RANKED_QUEUE_PATH) return new Response("Not found", { status: 404 });
        const user = await getUser(request, env);
        if (!user) return new Response("Sign in to queue for ranked.", { status: 401 });
        request = withIdentity(request, user);
      } else if (url.pathname.startsWith(RANKED_ROOM_PREFIX)) {
        // Seats need a session; spectators don't. The room sorts them out.
        request = withIdentity(request, await getUser(request, env));
      }
    }

    return (
      (await routePartykitRequest(request, env as unknown as Record<string, unknown>)) ??
      env.ASSETS.fetch(request)
    );
  },
} satisfies ExportedHandler<Env>;
