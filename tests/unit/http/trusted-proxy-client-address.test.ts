import { describe, expect, test } from "bun:test";
import { createTrustedProxyClientAddressResolver } from "../../../src/http/trusted-proxy-client-address";

describe("trusted proxy client address resolution", () => {
  test("ignores forwarding headers when no proxy is trusted", () => {
    const resolve = createTrustedProxyClientAddressResolver([]);

    expect(
      resolve({
        remoteAddress: "203.0.113.10",
        xForwardedFor: "198.51.100.7",
      }),
    ).toBe("203.0.113.10");
  });

  test("ignores forwarding headers from an untrusted direct peer", () => {
    const resolve = createTrustedProxyClientAddressResolver(["10.0.0.0/8"]);

    expect(
      resolve({
        remoteAddress: "203.0.113.10",
        xForwardedFor: "198.51.100.7",
      }),
    ).toBe("203.0.113.10");
  });

  test("walks a trusted proxy chain from right to left", () => {
    const resolve = createTrustedProxyClientAddressResolver([
      "10.0.0.0/8",
      "192.168.0.0/16",
    ]);

    expect(
      resolve({
        remoteAddress: "10.0.0.10",
        xForwardedFor: "198.51.100.20, 192.168.1.2, 10.0.0.9",
      }),
    ).toBe("198.51.100.20");
  });

  test("does not accept a client-prepended spoof before the first untrusted hop", () => {
    const resolve = createTrustedProxyClientAddressResolver(["10.0.0.0/8"]);

    expect(
      resolve({
        remoteAddress: "10.0.0.10",
        xForwardedFor: "203.0.113.66, 198.51.100.20",
      }),
    ).toBe("198.51.100.20");
  });

  test("falls back to the peer for malformed or oversized forwarding chains", () => {
    const resolve = createTrustedProxyClientAddressResolver(["10.0.0.0/8"]);

    expect(
      resolve({ remoteAddress: "10.0.0.10", xForwardedFor: "198.51.100.20, unknown" }),
    ).toBe("10.0.0.10");
    expect(
      resolve({
        remoteAddress: "10.0.0.10",
        xForwardedFor: Array.from({ length: 33 }, () => "10.0.0.1").join(","),
      }),
    ).toBe("10.0.0.10");
  });

  test("supports IPv6 trusted proxies and canonicalizes the selected client", () => {
    const resolve = createTrustedProxyClientAddressResolver(["2001:db8:ffff::/48"]);

    expect(
      resolve({
        remoteAddress: "2001:db8:ffff::10",
        xForwardedFor: "2001:0db8:0001:0:0:0:0:25",
      }),
    ).toBe("2001:db8:1::25");
  });

  test("treats IPv4-mapped IPv6 peers as IPv4 for trust matching", () => {
    const resolve = createTrustedProxyClientAddressResolver(["10.0.0.0/8"]);

    expect(
      resolve({
        remoteAddress: "::ffff:10.0.0.10",
        xForwardedFor: "198.51.100.20",
      }),
    ).toBe("198.51.100.20");
  });
});
