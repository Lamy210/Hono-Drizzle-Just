import { getConnInfo } from "hono/bun";
import type { RemoteAddressResolver } from "../remote-address";

export const resolveBunRemoteAddress: RemoteAddressResolver = (context) =>
  getConnInfo(context).remote.address;
