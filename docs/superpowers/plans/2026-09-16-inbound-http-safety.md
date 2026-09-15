# Inbound HTTP Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add configurable request-body limits with a structured Hono 413 contract and a stricter Bun transport hard cap.

**Architecture:** Keep body-size enforcement at the HTTP/runtime boundary. Hono owns the application-visible limit and common error response; Bun owns the final transport ceiling. Application services and repository/domain layers remain unchanged.

**Tech Stack:** Bun 1.4.2, Hono 4.13.7, TypeScript 7.0.2, Zod 4.6.2, Bun test.

**Spec:** `docs/superpowers/specs/2026-09-16-inbound-http-safety-design.md`

## Global Constraints

- Default Hono application limit: 1,048,576 bytes.
- Default Bun transport hard cap: 2,097,152 bytes.
- Transport max must be strictly greater than application max.
- Hono overflow uses `REQUEST_BODY_TOO_LARGE` / 413 and the common error envelope.
- Request context and request logger execute before body limiting.
- No new runtime dependency.
- No changes to domain/application service interfaces.
- Existing OpenTelemetry, authentication, validation, retry, database, and migration behavior must remain unchanged.

---

### Task 1: Configuration policy

**Files:**
- Modify: `tests/unit/config/load-config.test.ts`
- Modify: `src/config/config.schema.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces: `AppConfig.httpMaxRequestBodyBytes: number`
- Produces: `AppConfig.httpTransportMaxRequestBodyBytes: number`

- [ ] **Step 1: Add failing config tests**

Extend the defaults assertion with:

```ts
httpMaxRequestBodyBytes: 1_048_576,
httpTransportMaxRequestBodyBytes: 2_097_152,
```

Add a test that calls:

```ts
loadConfig({
  ...required,
  HTTP_MAX_REQUEST_BODY_BYTES: "4096",
  HTTP_TRANSPORT_MAX_REQUEST_BODY_BYTES: "4096",
})
```

and expects `ConfigurationError` because the hard cap is not greater than the application limit.

- [ ] **Step 2: Verify RED in CI**

Expected: unit/API test job fails because the current config does not expose these fields and does not reject the invalid relation.

- [ ] **Step 3: Implement schema fields and cross-field validation**

Add:

```ts
HTTP_MAX_REQUEST_BODY_BYTES: integerEnv(1_048_576, 1_024, 64 * 1024 * 1024),
HTTP_TRANSPORT_MAX_REQUEST_BODY_BYTES: integerEnv(2_097_152, 2_048, 128 * 1024 * 1024),
```

Use `superRefine` to reject transport max values less than or equal to the application max. Map them to camelCase `AppConfig` fields.

- [ ] **Step 4: Add both defaults to `.env.example` and verify GREEN**

---

### Task 2: Hono application-level body limit and 413 contract

**Files:**
- Modify: `src/core/errors/app-error.ts`
- Create: `src/http/middleware/request-body-limit.middleware.ts`
- Modify: `src/app/app.ts`
- Modify: `tests/api/users.test.ts`

**Interfaces:**
- Produces: `REQUEST_BODY_TOO_LARGE` error code with status 413.
- Produces: `createApp(dependencies, options?)`, where `options.maxRequestBodyBytes` overrides the 1 MiB default.

- [ ] **Step 1: Add failing API tests**

Use a small test limit (for example 128 bytes) and send an oversized JSON request without a `Content-Length` dependency. Assert:

```ts
expect(response.status).toBe(413)
expect(body).toMatchObject({
  error: {
    code: "REQUEST_BODY_TOO_LARGE",
    details: { maxBytes: 128 },
  },
})
```

Supply known `x-request-id` and `traceparent` headers and assert their correlation IDs are retained in the response. Also assert the create-user repository/service path was not reached.

Add a within-limit request proving normal route behavior remains available.

- [ ] **Step 2: Verify RED in CI**

Expected: oversized request reaches normal validation/handler behavior rather than returning the requested 413 contract.

- [ ] **Step 3: Implement middleware**

Create the middleware with Hono's built-in `bodyLimit()`:

```ts
bodyLimit({
  maxSize,
  onError: () => {
    throw new AppError(
      "REQUEST_BODY_TOO_LARGE",
      "Request body is too large",
      413,
      { maxBytes: maxSize },
    )
  },
})
```

Validate `maxSize` is a positive safe integer when constructing the middleware.

- [ ] **Step 4: Wire middleware after request context and request logger**

Add an optional `AppOptions.maxRequestBodyBytes`; default it to 1,048,576 bytes. Register body limiting after the existing request-context and request-logger middleware.

- [ ] **Step 5: Verify GREEN**

---

### Task 3: Bun transport hard cap

**Files:**
- Create: `src/app/server-options.ts`
- Create: `tests/unit/app/server-options.test.ts`
- Modify: `src/app/server.ts`

**Interfaces:**
- Produces: a pure `createBunServerOptions()` helper used by `Bun.serve()`.

- [ ] **Step 1: Refactor current Bun serve options into a pure helper without behavior change**

The helper initially returns the existing `{ port, fetch }` shape. Keep tests green.

- [ ] **Step 2: Add a failing test for the transport cap**

Given `maxRequestBodySize: 2_097_152`, assert the returned options contain:

```ts
maxRequestBodySize: 2_097_152
```

- [ ] **Step 3: Verify RED**

Expected: property is absent.

- [ ] **Step 4: Implement and wire the hard cap**

`server.ts` calls `createApp(..., { maxRequestBodyBytes: config.httpMaxRequestBodyBytes })` and `Bun.serve(createBunServerOptions({ port, fetch: app.fetch, maxRequestBodySize: config.httpTransportMaxRequestBodyBytes }))`.

- [ ] **Step 5: Verify GREEN**

---

### Task 4: OpenAPI and documentation

**Files:**
- Modify: `src/modules/users/presentation/user.routes.ts`
- Modify: `README.md`
- Modify: `docs/architecture.md`

- [ ] **Step 1: Document 413 on POST /users**

Add a `413` response using `ErrorResponseSchema` with description `Request body too large`.

- [ ] **Step 2: Document configuration and dual-boundary semantics**

Explain that Hono's limit returns the common JSON error contract, while Bun can reject payloads above the transport hard cap before Hono and therefore may return a transport-level 413 without correlation JSON.

- [ ] **Step 3: Mention Hono's built-in body limit and middleware order in architecture docs**

---

### Task 5: Final verification and PR

**Files:** all changed files.

- [ ] **Step 1: Run final branch CI**

Require both `quality` and `integration` to pass. The quality job must pass migration verification, lint, typecheck, and unit/API tests.

- [ ] **Step 2: Review diff for scope creep**

Confirm there is no multipart policy, per-route override API, rate limiter, timeout middleware, decompression policy, or new dependency.

- [ ] **Step 3: Open PR**

Title:

```text
feat: add inbound HTTP request body safety
```

PR body must include RED/GREEN CI evidence, the 1 MiB / 2 MiB defaults, the Hono-versus-Bun 413 distinction, and non-goals.