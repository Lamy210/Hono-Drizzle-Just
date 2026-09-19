import { secureHeaders } from "hono/secure-headers";

export function createApiSecurityHeadersMiddleware() {
  return secureHeaders({
    crossOriginOpenerPolicy: false,
    crossOriginResourcePolicy: false,
    originAgentCluster: false,
    strictTransportSecurity: false,
  });
}
