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

  const members = splitEntityTagList(trimmed, "If-Match");
  const versions = new Set<number>();
  for (const member of members) {
    if (member.startsWith("W/")) {
      continue;
    }
    const version = userVersionFromEntityTag(member);
    if (version !== undefined) {
      versions.add(version);
    }
  }

  return { kind: "versions", versions: [...versions] };
}

export function userIfNoneMatchMatches(value: string, currentVersion: number): boolean {
  const trimmed = value.trim();
  if (trimmed === "*") {
    return true;
  }

  const members = splitEntityTagList(trimmed, "If-None-Match");
  return members.some((member) => {
    const strongForm = member.startsWith("W/") ? member.slice(2) : member;
    return userVersionFromEntityTag(strongForm) === currentVersion;
  });
}

function userVersionFromEntityTag(value: string): number | undefined {
  const match = USER_ETAG_PATTERN.exec(value);
  if (!match) {
    return undefined;
  }
  const version = Number(match[1]);
  return Number.isSafeInteger(version) && version >= 1 ? version : undefined;
}

function splitEntityTagList(value: string, headerName: "If-Match" | "If-None-Match"): readonly string[] {
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
        throw malformedEntityTagHeader(headerName);
      }
      members.push(member);
      start = index + 1;
    }
  }

  if (quoted) {
    throw malformedEntityTagHeader(headerName);
  }

  const finalMember = value.slice(start).trim();
  if (!finalMember) {
    throw malformedEntityTagHeader(headerName);
  }
  members.push(finalMember);

  for (const member of members) {
    if (
      member === "*" ||
      !/^(?:W\/)?"[\x21\x23-\x7e\x80-\xff]*"$/.test(member)
    ) {
      throw malformedEntityTagHeader(headerName);
    }
  }

  return members;
}

function malformedEntityTagHeader(headerName: string): AppError {
  return new AppError("VALIDATION_ERROR", `${headerName} header is malformed`, 400);
}
