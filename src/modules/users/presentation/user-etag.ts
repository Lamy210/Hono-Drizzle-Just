import { AppError } from "../../../core/errors/app-error";
import type { UserVersionPrecondition } from "../application/user-version-precondition";

const USER_ETAG_PATTERN = /^"v([1-9][0-9]*)"$/;

export function formatUserEntityTag(version: number): string {
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error("User version must be a positive safe integer");
  }
  return `"v${version}"`;
}

export function parseUserIfMatch(value: string): UserVersionPrecondition {
  const trimmed = value.trim();
  if (trimmed === "*") {
    return { kind: "any-current" };
  }

  const members = splitEntityTagList(trimmed);
  if (members.length === 0) {
    throw malformedIfMatch();
  }

  const versions = new Set<number>();
  for (const member of members) {
    if (member.startsWith("W/")) {
      continue;
    }
    const match = USER_ETAG_PATTERN.exec(member);
    if (!match) {
      continue;
    }
    const version = Number(match[1]);
    if (Number.isSafeInteger(version) && version >= 1) {
      versions.add(version);
    }
  }

  return { kind: "versions", versions: [...versions] };
}

function splitEntityTagList(value: string): readonly string[] {
  const members: string[] = [];
  let start = 0;
  let quoted = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (quoted) {
      continue;
    }
    if (character === ",") {
      const member = value.slice(start, index).trim();
      if (!member) {
        throw malformedIfMatch();
      }
      members.push(member);
      start = index + 1;
    }
  }

  if (quoted) {
    throw malformedIfMatch();
  }

  const finalMember = value.slice(start).trim();
  if (!finalMember) {
    throw malformedIfMatch();
  }
  members.push(finalMember);

  for (const member of members) {
    if (
      member === "*" ||
      !/^(?:W\/)?"[\x21\x23-\x7e\x80-\xff]*"$/.test(member)
    ) {
      throw malformedIfMatch();
    }
  }

  return members;
}

function malformedIfMatch(): AppError {
  return new AppError("VALIDATION_ERROR", "If-Match header is malformed", 400);
}
