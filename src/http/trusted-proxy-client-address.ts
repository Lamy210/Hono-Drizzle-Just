import {
  isIpInCidr,
  parseIpAddress,
  parseIpCidr,
  type IpAddress,
  type IpCidr,
} from "../core/network/ip-cidr";
import type { ClientAddressResolver } from "./client-address";

const MAX_X_FORWARDED_FOR_LENGTH = 4_096;
const MAX_FORWARDED_HOPS = 32;

function parseForwardedChain(value: string | undefined): readonly IpAddress[] | undefined {
  if (value === undefined || value.length === 0 || value.length > MAX_X_FORWARDED_FOR_LENGTH) {
    return undefined;
  }

  const parts = value.split(",");
  if (parts.length === 0 || parts.length > MAX_FORWARDED_HOPS) {
    return undefined;
  }

  const addresses: IpAddress[] = [];
  for (const part of parts) {
    const address = parseIpAddress(part.trim());
    if (!address) {
      return undefined;
    }
    addresses.push(address);
  }
  return addresses;
}

export function createTrustedProxyClientAddressResolver(
  trustedProxyCidrs: readonly string[],
): ClientAddressResolver {
  const trustedNetworks: readonly IpCidr[] = trustedProxyCidrs.map((value) => {
    const cidr = parseIpCidr(value);
    if (!cidr) {
      throw new TypeError(`Invalid trusted proxy CIDR: ${value}`);
    }
    return cidr;
  });

  const isTrusted = (address: IpAddress): boolean =>
    trustedNetworks.some((network) => isIpInCidr(address, network));

  return ({ remoteAddress, xForwardedFor }) => {
    if (remoteAddress === undefined) {
      return undefined;
    }

    const peer = parseIpAddress(remoteAddress);
    if (!peer) {
      return remoteAddress;
    }

    if (trustedNetworks.length === 0 || !isTrusted(peer)) {
      return peer.canonical;
    }

    const forwarded = parseForwardedChain(xForwardedFor);
    if (!forwarded || forwarded.length === 0) {
      return peer.canonical;
    }

    for (let index = forwarded.length - 1; index >= 0; index -= 1) {
      const address = forwarded[index];
      if (address !== undefined && !isTrusted(address)) {
        return address.canonical;
      }
    }

    return forwarded[0]?.canonical ?? peer.canonical;
  };
}
