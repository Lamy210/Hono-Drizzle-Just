import type { RequestContext } from "../core/context/request-context";
import type { Logger } from "../core/logging/logger";

export type AppEnv = {
  Variables: {
    requestContext: RequestContext;
    logger: Logger;
  };
};
