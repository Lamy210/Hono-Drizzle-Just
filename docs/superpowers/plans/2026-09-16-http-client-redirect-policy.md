# Outbound HTTP Redirect Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent `FetchHttpClient` from silently following redirects away from its configured upstream and fail fast on unsafe base URL configuration.

**Architecture:** Keep the existing `HttpClient` port unchanged. Enforce the redirect and base-URL trust boundary entirely inside the `FetchHttpClient` adapter so application services remain provider-neutral. Reuse the existing upstream error mapping for redirect responses rather than adding a new public error contract.

**Tech Stack:** Bun 1.4.2, TypeScript 7, Bun test, Hono application architecture, native Fetch API.

**Spec:** `docs/superpowers/specs/2026-09-16-http-client-redirect-policy-design.md`

## Global Constraints

- Do not change the `HttpClient` application port.
- Default redirect behavior must be deny/manual, with no per-request escape hatch in this change.
- Existing retry, tracing, deadline, response validation, and request-correlation behavior must remain unchanged.
- Only `http:` and `https:` base URLs are valid.
- Base URLs with embedded username/password credentials are invalid.
- No new runtime dependencies.
- Follow the existing Biome formatting and TypeScript conventions.

---

### Task 1: Specify redirect behavior with failing tests

**Files:**
- Modify: `tests/unit/infrastructure/fetch-http-client.test.ts`

**Interfaces:**
- Consumes: existing `FetchHttpClient`, injected `FetchLike`, `AppError` behavior.
- Produces: executable regression specifications for manual redirect mode and redirect response handling.

- [ ] **Step 1: Extend the existing successful-request test to capture the fetch init and assert manual redirect mode**

Use the injected fetch implementation and assert:

```ts
let capturedRedirect: RequestRedirect | undefined;
const fetchImpl: FetchLike = async (_input, init) => {
  capturedRedirect = init?.redirect;
  return Response.json({ id: "550e8400-e29b-41d4-a716-446655440000", name: "Lamy" });
};

expect(capturedRedirect).toBe("manual");
```

The production change that makes this pass is adding `redirect: "manual"` to the fetch init object.

- [ ] **Step 2: Add a redirect-response regression test**

Use an injected fetch implementation that returns:

```ts
new Response(null, {
  status: 302,
  headers: { location: "https://evil.example/redirected" },
});
```

Assert that `client.request(...)` rejects with:

```ts
{ code: "UPSTREAM_REQUEST_FAILED", details: { status: 302, host: "example.test" } }
```

This demonstrates that a redirect response is surfaced rather than followed.

- [ ] **Step 3: Push only the test change and verify RED in GitHub Actions**

Expected result: the unit/API quality job fails because `capturedRedirect` is `undefined`, proving the test detects the missing redirect policy. The redirect-response test may already pass with an injected fetch stub; the manual-mode assertion is the required RED signal.

---

### Task 2: Implement the minimal redirect policy

**Files:**
- Modify: `src/infrastructure/http/fetch-http-client.ts`

**Interfaces:**
- Consumes: native `RequestInit.redirect` field.
- Produces: every physical fetch attempt uses `redirect: "manual"`.

- [ ] **Step 1: Add the minimal fetch init change**

Change the existing call from:

```ts
const response = await this.fetchImpl(url, {
  method: request.method,
  headers,
  ...(body === undefined ? {} : { body }),
  signal: this.signalFactory(attemptTimeoutMs),
});
```

to:

```ts
const response = await this.fetchImpl(url, {
  method: request.method,
  headers,
  ...(body === undefined ? {} : { body }),
  redirect: "manual",
  signal: this.signalFactory(attemptTimeoutMs),
});
```

- [ ] **Step 2: Push and verify GREEN for the redirect tests**

Expected result: the new redirect-mode assertion passes and the existing non-2xx error mapping handles the `302` response.

---

### Task 3: Specify and implement base URL validation

**Files:**
- Modify: `tests/unit/infrastructure/fetch-http-client.test.ts`
- Modify: `src/infrastructure/http/fetch-http-client.ts`

**Interfaces:**
- Consumes: `FetchHttpClientOptions.baseUrl`.
- Produces: constructor-time validation with `RangeError` for unsafe protocols or embedded credentials.

- [ ] **Step 1: Add failing constructor tests**

Add tests equivalent to:

```ts
expect(
  () =>
    new FetchHttpClient({
      baseUrl: "ftp://example.test",
      logger,
      fetchImpl: fetch,
    }),
).toThrow(RangeError);

expect(
  () =>
    new FetchHttpClient({
      baseUrl: "https://user:secret@example.test",
      logger,
      fetchImpl: fetch,
    }),
).toThrow(RangeError);
```

- [ ] **Step 2: Push test-only change and verify RED**

Expected result: both constructor tests fail because the current constructor accepts those URLs.

- [ ] **Step 3: Implement a focused base URL parser/validator**

Add a helper near `positiveFiniteNumber`:

```ts
function parseBaseUrl(value: string | URL): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new RangeError("baseUrl must use http or https");
  }
  if (url.username !== "" || url.password !== "") {
    throw new RangeError("baseUrl must not contain credentials");
  }
  return url;
}
```

Then construct with:

```ts
this.baseUrl = parseBaseUrl(options.baseUrl);
```

- [ ] **Step 4: Push and verify GREEN**

Expected result: new constructor tests pass and all pre-existing HTTP-client tests remain green.

---

### Task 4: Document the policy and run full verification

**Files:**
- Modify: `README.md`
- Modify: `docs/architecture.md`

**Interfaces:**
- Consumes: the implemented redirect/base-URL behavior.
- Produces: consumer-facing and architecture-level documentation that matches runtime behavior.

- [ ] **Step 1: Update README outbound HTTP policy**

State explicitly:

- configured base URLs are limited to HTTP(S) and cannot contain credentials;
- redirects are not followed automatically;
- redirect support, if needed, must be introduced through explicit policy rather than relying on fetch defaults.

- [ ] **Step 2: Update architecture documentation**

Document the adapter trust boundary around URL resolution and redirect handling without changing the application-owned `HttpClient` port.

- [ ] **Step 3: Verify full CI**

Required jobs:

```text
quality
integration
```

Both must complete successfully on the final branch head.

- [ ] **Step 4: Review the diff for scope creep**

Confirm the change does not add redirect allowlists, private-network detection, new dependencies, or public-port changes.

- [ ] **Step 5: Open a pull request**

Use a concise title such as:

```text
fix: harden outbound HTTP redirect policy
```

The PR body should summarize the trust-boundary issue, TDD evidence, behavior change, tests, and explicitly list non-goals.
