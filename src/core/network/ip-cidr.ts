export interface IpAddress {
  readonly version: 4 | 6;
  readonly value: bigint;
  readonly canonical: string;
}

export interface IpCidr {
  readonly version: 4 | 6;
  readonly prefixLength: number;
  readonly network: bigint;
}

function parseIpv4(value: string): IpAddress | undefined {
  const parts = value.split(".");
  if (parts.length !== 4) {
    return undefined;
  }

  const octets: number[] = [];
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) {
      return undefined;
    }
    const octet = Number(part);
    if (octet > 255) {
      return undefined;
    }
    octets.push(octet);
  }

  let numeric = 0n;
  for (const octet of octets) {
    numeric = (numeric << 8n) | BigInt(octet);
  }

  return {
    version: 4,
    value: numeric,
    canonical: octets.join("."),
  };
}

function parseIpv6Groups(value: string): number[] | undefined {
  if (value.length === 0 || value.includes("%")) {
    return undefined;
  }

  const doubleColon = value.indexOf("::");
  if (doubleColon !== -1 && doubleColon !== value.lastIndexOf("::")) {
    return undefined;
  }

  const hasCompression = doubleColon !== -1;
  const [leftRaw = "", rightRaw = ""] = hasCompression ? value.split("::") : [value, ""];
  const left = leftRaw === "" ? [] : leftRaw.split(":");
  const right = rightRaw === "" ? [] : rightRaw.split(":");

  const convert = (tokens: readonly string[], allowIpv4AtEnd: boolean): number[] | undefined => {
    const groups: number[] = [];
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (token === undefined || token === "") {
        return undefined;
      }
      if (token.includes(".")) {
        if (!allowIpv4AtEnd || index !== tokens.length - 1) {
          return undefined;
        }
        const ipv4 = parseIpv4(token);
        if (!ipv4) {
          return undefined;
        }
        groups.push(Number((ipv4.value >> 16n) & 0xffffn), Number(ipv4.value & 0xffffn));
        continue;
      }
      if (!/^[0-9A-Fa-f]{1,4}$/.test(token)) {
        return undefined;
      }
      groups.push(Number.parseInt(token, 16));
    }
    return groups;
  };

  const leftGroups = convert(left, right.length === 0);
  const rightGroups = convert(right, true);
  if (!leftGroups || !rightGroups) {
    return undefined;
  }

  const explicitCount = leftGroups.length + rightGroups.length;
  if (hasCompression) {
    const missing = 8 - explicitCount;
    if (missing < 1) {
      return undefined;
    }
    return [...leftGroups, ...Array.from({ length: missing }, () => 0), ...rightGroups];
  }

  return explicitCount === 8 ? leftGroups : undefined;
}

function canonicalizeIpv6(groups: readonly number[]): string {
  let bestStart = -1;
  let bestLength = 0;

  for (let index = 0; index < groups.length; ) {
    if (groups[index] !== 0) {
      index += 1;
      continue;
    }
    let end = index;
    while (end < groups.length && groups[end] === 0) {
      end += 1;
    }
    const length = end - index;
    if (length > bestLength && length >= 2) {
      bestStart = index;
      bestLength = length;
    }
    index = end;
  }

  const rendered = groups.map((group) => group.toString(16));
  if (bestStart === -1) {
    return rendered.join(":");
  }

  const left = rendered.slice(0, bestStart).join(":");
  const right = rendered.slice(bestStart + bestLength).join(":");
  return `${left}::${right}`;
}

function parseIpv6(value: string): IpAddress | undefined {
  const groups = parseIpv6Groups(value);
  if (!groups) {
    return undefined;
  }

  if (
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0xffff
  ) {
    const ipv4Value = (BigInt(groups[6] ?? 0) << 16n) | BigInt(groups[7] ?? 0);
    return {
      version: 4,
      value: ipv4Value,
      canonical: [
        Number((ipv4Value >> 24n) & 0xffn),
        Number((ipv4Value >> 16n) & 0xffn),
        Number((ipv4Value >> 8n) & 0xffn),
        Number(ipv4Value & 0xffn),
      ].join("."),
    };
  }

  let numeric = 0n;
  for (const group of groups) {
    numeric = (numeric << 16n) | BigInt(group);
  }

  return {
    version: 6,
    value: numeric,
    canonical: canonicalizeIpv6(groups),
  };
}

export function parseIpAddress(value: string): IpAddress | undefined {
  return value.includes(":") ? parseIpv6(value) : parseIpv4(value);
}

export function parseIpCidr(value: string): IpCidr | undefined {
  const separator = value.indexOf("/");
  if (separator <= 0 || separator !== value.lastIndexOf("/")) {
    return undefined;
  }

  const address = parseIpAddress(value.slice(0, separator));
  const prefixRaw = value.slice(separator + 1);
  if (!address || !/^(0|[1-9][0-9]{0,2})$/.test(prefixRaw)) {
    return undefined;
  }

  const prefixLength = Number(prefixRaw);
  const bitLength = address.version === 4 ? 32 : 128;
  if (prefixLength > bitLength) {
    return undefined;
  }

  const hostBits = BigInt(bitLength - prefixLength);
  const network = hostBits === 0n ? address.value : (address.value >> hostBits) << hostBits;
  return {
    version: address.version,
    prefixLength,
    network,
  };
}

export function isIpInCidr(address: IpAddress, cidr: IpCidr): boolean {
  if (address.version !== cidr.version) {
    return false;
  }

  const bitLength = address.version === 4 ? 32 : 128;
  const hostBits = BigInt(bitLength - cidr.prefixLength);
  const network = hostBits === 0n ? address.value : (address.value >> hostBits) << hostBits;
  return network === cidr.network;
}
