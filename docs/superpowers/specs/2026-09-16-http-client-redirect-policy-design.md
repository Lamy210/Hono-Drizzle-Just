# Outbound HTTP Redirect Policy Design

## Goal

Make `FetchHttpClient` preserve its configured-upstream trust boundary even when an upstream returns an HTTP redirect.

## Problem

`FetchHttpClient` rejects caller-supplied absolute request URLs and resolves request paths against a configured `baseUrl`, but it currently delegates redirect handling to `fetch`. The Fetch default is to follow redirects, which can move a request away from the configured upstream after the initial URL has been validated.

That behavior weakens the abstraction's existing guarantee that callers cannot override the configured host.

## Decision

`FetchHttpClient` will use `redirect: "manual"` for every underlying fetch attempt.

A redirect response therefore remains an ordinary non-success upstream response and is mapped through the existing `UPSTREAM_REQUEST_FAILED` path. The client will not resolve or follow a `Location` header automatically.

No configurable redirect mode is added in this change. If a future consumer needs redirect support, it must be introduced as an explicit policy with host/scheme rules rather than by restoring the platform default.

## Base URL validation

The constructor will reject base URLs that are unsuitable for outbound HTTP requests:

- schemes other than `http:` and `https:`;
- embedded username or password credentials.

The constructor will continue to accept an origin with an optional path prefix. Query strings and fragments are not rejected in this change because `new URL(request.path, baseUrl)` replaces them for the request URL and they do not expand the upstream host trust boundary.

Invalid base URLs will fail fast with `RangeError`, matching the constructor's existing fail-fast validation style for invalid timeout configuration.

## Non-goals

This change does not add:

- DNS/IP allowlists or private-network blocking;
- redirect allowlists;
- automatic same-origin redirect following;
- per-request redirect overrides;
- proxy configuration;
- retry behavior changes.

Those are separate policies and should not be bundled into this safety fix.

## Required tests

1. A normal request passes `redirect: "manual"` to the injected fetch implementation.
2. A `302` response with a `Location` header is not followed and is surfaced as `UPSTREAM_REQUEST_FAILED` with status `302`.
3. Unsupported base URL schemes fail during construction.
4. Base URLs containing credentials fail during construction.
5. Existing tracing, retry, deadline, response validation, and absolute-path rejection tests remain green.

## Documentation

Update the outbound HTTP policy documentation to state that redirects are denied by default and that configured base URLs must use HTTP(S) without embedded credentials.
