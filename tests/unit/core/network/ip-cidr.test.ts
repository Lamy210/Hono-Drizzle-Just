import { describe, expect, test } from "bun:test";
import { isIpInCidr, parseIpAddress, parseIpCidr } from "../../../../src/core/network/ip-cidr";

describe("IP/CIDR parsing", () => {
  test("canonicalizes IPv4 and IPv6 literals", () => {
    expect(parseIpAddress("192.0.2.10")?.canonical).toBe("192.0.2.10");
    expect(parseIpAddress("2001:0db8:0:0:0:0:0:1")?.canonical).toBe("2001:db8::1");
    expect(parseIpAddress("::ffff:192.0.2.10")?.canonical).toBe("192.0.2.10");
  });

  test("rejects ambiguous or malformed IP literals", () => {
    for (const value of ["01.2.3.4", "256.0.0.1", "2001:::1", "fe80::1%eth0", "not-an-ip"]) {
      expect(parseIpAddress(value)).toBeUndefined();
    }
  });

  test("matches IPv4 and IPv6 CIDRs", () => {
    const ipv4 = parseIpAddress("10.20.30.40");
    const ipv4Cidr = parseIpCidr("10.0.0.0/8");
    const ipv6 = parseIpAddress("2001:db8:10::1");
    const ipv6Cidr = parseIpCidr("2001:db8::/32");

    expect(ipv4 && ipv4Cidr ? isIpInCidr(ipv4, ipv4Cidr) : false).toBe(true);
    expect(ipv6 && ipv6Cidr ? isIpInCidr(ipv6, ipv6Cidr) : false).toBe(true);
    expect(parseIpCidr("10.0.0.0/33")).toBeUndefined();
    expect(parseIpCidr("2001:db8::/129")).toBeUndefined();
  });
});
