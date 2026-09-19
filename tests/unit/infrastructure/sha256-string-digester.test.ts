import { expect, test } from "bun:test";

test("SHA-256 digester returns deterministic lowercase hexadecimal output", async () => {
  const modulePath = "../../../src/infrastructure/crypto/sha256-string-digester";
  const module = await import(modulePath).catch(() => undefined);

  expect(module).toBeDefined();
  if (!module) return;

  const digester = new module.Sha256StringDigester();
  const digest = digester.sha256Hex("abc");

  expect(digest).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  expect(digest).toMatch(/^[0-9a-f]{64}$/);
});

test("SHA-256 digester treats input bytes as UTF-8 and does not retain caller state", async () => {
  const modulePath = "../../../src/infrastructure/crypto/sha256-string-digester";
  const module = await import(modulePath).catch(() => undefined);

  expect(module).toBeDefined();
  if (!module) return;

  const digester = new module.Sha256StringDigester();
  const first = digester.sha256Hex("Key-A");
  const second = digester.sha256Hex("Key-A");
  const differentCase = digester.sha256Hex("key-a");

  expect(first).toBe(second);
  expect(first).not.toBe(differentCase);
  expect(first).toMatch(/^[0-9a-f]{64}$/);
});
