# Inbound HTTP Safety Design

## Goal

Add explicit request-body size boundaries to the Bun + Hono template without leaking transport concerns into application services.

## Decisions

- The application-level request body limit defaults to **1 MiB (1,048,576 bytes)**.
- The Bun transport hard cap defaults to **2 MiB (2,097,152 bytes)**.
- Both values are typed startup configuration:
  - `HTTP_MAX_REQUEST_BODY_BYTES`
  - `HTTP_TRANSPORT_MAX_REQUEST_BODY_BYTES`
- The transport hard cap must be strictly greater than the application-level limit. This gives Hono room to return the common structured `413` response for ordinary over-limit requests while Bun remains the final memory/transport safety boundary.
- The application-level limit uses Hono's built-in `bodyLimit()` middleware. Hono 4.13.7 is above the patched version for the 2026 chunked/unknown-length bypass fixed in 4.12.16.
- Body limiting runs after request-context and request-logger middleware, so a Hono-level `413` preserves request/trace correlation and normal request logging.
- Hono overflow throws an application error with code `REQUEST_BODY_TOO_LARGE` and HTTP status `413`; the existing common error handler creates the response body.
- Bun overflow above the hard cap may be rejected before Hono executes and therefore is not guaranteed to use the application JSON error envelope. This is intentional and must be documented.

## Error contract

For a request rejected by the Hono application limit:

```json
{
  "error": {
    "code": "REQUEST_BODY_TOO_LARGE",
    "message": "Request body is too large",
    "details": {
      "maxBytes": 1048576
    }
  },
  "requestId": "...",
  "traceId": "..."
}
```

The response status is `413`.

## Middleware order

```text
request context / trace
  -> request logger
    -> body limit
      -> route validation / handler
```

This order is required so rejected requests retain correlation and are visible in normal request/error logs.

## Configuration bounds

- `HTTP_MAX_REQUEST_BODY_BYTES`: 1 KiB .. 64 MiB.
- `HTTP_TRANSPORT_MAX_REQUEST_BODY_BYTES`: 2 KiB .. 128 MiB.
- Transport max must be greater than application max.

The defaults target ordinary JSON APIs. Applications that intentionally accept large uploads should review route-specific limits and transport settings rather than blindly increasing the global defaults.

## OpenAPI

The sample `POST /users` route documents `413` using the existing `ErrorResponseSchema`. Global middleware behavior cannot automatically add this response to every future OpenAPI route, so new body-bearing routes must document `413` when they rely on the global limit.

## Non-goals

This PR does not add:

- multipart/file-upload specific policies;
- per-route body size overrides;
- decompressed-body size enforcement;
- rate limiting;
- request timeouts/slowloris protection;
- reverse-proxy/WAF limits;
- streaming upload support.

Those are separate policies and should remain independently testable.

## Required verification

1. Config defaults expose 1 MiB application and 2 MiB transport limits.
2. Invalid numeric bounds fail startup configuration.
3. Transport max <= application max fails configuration.
4. Oversized request without relying on `Content-Length` returns structured 413 before the user service executes.
5. Oversized request preserves request ID and trace ID correlation.
6. A request within the configured limit still reaches normal route validation/handler behavior.
7. Bun server options use the configured transport hard cap.
8. Existing API, unit, migration, and PostgreSQL integration suites remain green.