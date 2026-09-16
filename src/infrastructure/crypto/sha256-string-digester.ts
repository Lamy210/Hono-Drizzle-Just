import { createHash } from "node:crypto";
import type { StringDigester } from "../../core/crypto/string-digester";

export class Sha256StringDigester implements StringDigester {
  sha256Hex(value: string): string {
    return createHash("sha256").update(value, "utf8").digest("hex");
  }
}
