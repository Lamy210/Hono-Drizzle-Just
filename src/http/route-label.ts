import { routePath } from "hono/route";

export function httpRouteLabel(c: Parameters<typeof routePath>[0]): string {
  return routePath(c, -1) || "unmatched";
}
