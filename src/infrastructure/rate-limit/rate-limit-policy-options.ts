export interface RateLimitPolicySnapshot {
  readonly limit: number;
  readonly windowSeconds: number;
}

export interface RateLimitPolicyOptionsSnapshot extends RateLimitPolicySnapshot {
  readonly policies: Readonly<Record<string, RateLimitPolicySnapshot>>;
}

function requireNonArrayObject(
  value: unknown,
  invalidMessage: string,
  unreadableMessage: string,
): object {
  if (typeof value !== "object" || value === null) {
    throw new TypeError(invalidMessage);
  }

  let isArray: boolean;
  try {
    isArray = Array.isArray(value);
  } catch {
    throw new TypeError(unreadableMessage);
  }
  if (isArray) {
    throw new TypeError(invalidMessage);
  }

  return value;
}

function snapshotPolicy(policy: unknown): RateLimitPolicySnapshot {
  const source = requireNonArrayObject(
    policy,
    "Rate limit policy must be a non-array object",
    "Rate limit policy could not be read",
  );

  try {
    return {
      limit: Reflect.get(source, "limit") as number,
      windowSeconds: Reflect.get(source, "windowSeconds") as number,
    };
  } catch {
    throw new TypeError("Rate limit policy could not be read");
  }
}

export function snapshotRateLimitPolicyOptions(options: unknown): RateLimitPolicyOptionsSnapshot {
  const source = requireNonArrayObject(
    options,
    "Rate limiter options must be a non-array object",
    "Rate limiter options could not be read",
  );

  let limit: unknown;
  let windowSeconds: unknown;
  let runtimePolicies: unknown;
  try {
    limit = Reflect.get(source, "limit");
    windowSeconds = Reflect.get(source, "windowSeconds");
    runtimePolicies = Reflect.get(source, "policies");
  } catch {
    throw new TypeError("Rate limiter options could not be read");
  }

  if (runtimePolicies === undefined) {
    return {
      limit: limit as number,
      windowSeconds: windowSeconds as number,
      policies: {},
    };
  }

  const policiesSource = requireNonArrayObject(
    runtimePolicies,
    "Rate limiter policies must be a non-array object",
    "Rate limiter policies could not be read",
  );

  let entries: [string, unknown][];
  try {
    entries = Object.entries(policiesSource);
  } catch {
    throw new TypeError("Rate limiter policies could not be read");
  }

  return {
    limit: limit as number,
    windowSeconds: windowSeconds as number,
    policies: Object.fromEntries(entries.map(([scope, policy]) => [scope, snapshotPolicy(policy)])),
  };
}
