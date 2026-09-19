import type { Context } from "hono";
import type { AppEnv } from "./env";

export type RemoteAddressResolver = (context: Context<AppEnv>) => string | undefined;
