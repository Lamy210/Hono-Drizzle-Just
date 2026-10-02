import type { TraceContext } from "../../core/tracing/trace-context";
import { AppError } from "../../core/errors/app-error";
import type {
  HttpClient,
  HttpMethod,
  HttpRequest,
  HttpResponse,
  SchemaParser,
} from "../../core/http/http-client";
import type { LogContext, Logger } from "../../core/logging/logger";
import type { Meter } from "../../core/observability/meter";
import { NoopMeter } from "../../core/observability/noop-meter";
import { NoopTracer } from "../../core/observability/noop-tracer";
import type {
  SpanStatus,
  TelemetryAttributeValue,
  Tracer,
} from "../../core/observability/tracer";
import { DefaultRetryPolicy, type RetryPolicy } from "./retry-policy";
import { formatTraceParent, parseTraceParent, parseTraceState } from "../tracing/w3c-trace-context";

const OUTBOUND_HTTP_METHODS = new Set<HttpMethod>([
  "GET",
  "HEAD",
  "OPTIONS",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);

const TRANSPORT_OWNED_REQUEST_HEADERS = new Set([
  "connection",
  "content-length",
  "expect",
  "host",
  "keep-alive",
  "proxy-connection",
  "te",
  "traceparent",
  "tracestate",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-request-id",
]);

function positiveFiniteNumber(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a finite number greater than 0`);
  }
  return value;
}

function positiveSafeInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function hasRawUrlControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
      return true;
    }
  }
  return false;
}

function hasDotPathSegment(value: string): boolean {
  const pathname = value.split("?", 1)[0] ?? value;
  return pathname
    .split("/")
    .some((segment) => /^(?:\.|%2e){1,2}$/i.test(segment));
}

function hasAmbiguousContentTypeValue(value: string): boolean {
  let quoted = false;
  let escaped = false;

  for (const character of value) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && character === ",") {
      return true;
    }
  }

  return quoted || escaped;
}

function parseBaseUrl(value: string | URL): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RangeError("baseUrl must be a valid absolute URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new RangeError("baseUrl must use http or https");
  }
  if (url.username !== "" || url.password !== "") {
    throw new RangeError("baseUrl must not contain credentials");
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new RangeError("baseUrl must be an origin URL without path, query, or fragment");
  }
  return url;
}

export type FetchLike = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => ReturnType<typeof fetch>;

export type SleepLike = (delayMs: number) => Promise<void>;
export type MonotonicNow = () => number;
type RequestNow = () => number;
type OutboundRequestContext = {
  readonly requestId: string;
  readonly trace: TraceContext;
};
export type TimeoutSignalFactory = (timeoutMs: number) => AbortSignal;

export interface FetchHttpClientOptions {
  readonly baseUrl: string | URL;
  readonly logger: Logger;
  readonly fetchImpl?: FetchLike;
  /** Total time budget across attempts and retry delays. */
  readonly defaultTimeoutMs?: number;
  /** Maximum time budget for one fetch attempt. */
  readonly defaultAttemptTimeoutMs?: number;
  /** Maximum serialized JSON request-body bytes before any network attempt. */
  readonly defaultMaxRequestBytes?: number;
  /** Maximum successful response-body bytes read before JSON parsing. */
  readonly defaultMaxResponseBytes?: number;
  readonly retryPolicy?: RetryPolicy;
  readonly sleep?: SleepLike;
  readonly now?: MonotonicNow;
  readonly signalFactory?: TimeoutSignalFactory;
  readonly tracer?: Tracer;
  readonly meter?: Meter;
}

export class FetchHttpClient implements HttpClient {
  private readonly baseUrl: URL;
  private readonly fetchImpl: unknown;
  private readonly defaultTimeoutMs: number;
  private readonly defaultAttemptTimeoutMs: number;
  private readonly defaultMaxRequestBytes: number;
  private readonly defaultMaxResponseBytes: number;
  private readonly retryPolicy: RetryPolicy;
  private readonly sleep: SleepLike;
  private readonly now: MonotonicNow;
  private readonly signalFactory: TimeoutSignalFactory;
  private readonly logger: Logger;
  private readonly tracer: Tracer;
  private readonly meter: Meter;

  constructor(options: FetchHttpClientOptions) {
    this.baseUrl = parseBaseUrl(options.baseUrl);
    this.fetchImpl = options.fetchImpl === undefined ? fetch : options.fetchImpl;
    this.defaultTimeoutMs = positiveFiniteNumber(
      "defaultTimeoutMs",
      options.defaultTimeoutMs ?? 10_000,
    );
    this.defaultAttemptTimeoutMs = positiveFiniteNumber(
      "defaultAttemptTimeoutMs",
      options.defaultAttemptTimeoutMs ?? 3_000,
    );
    this.defaultMaxRequestBytes = positiveSafeInteger(
      "defaultMaxRequestBytes",
      options.defaultMaxRequestBytes ?? 1_048_576,
    );
    this.defaultMaxResponseBytes = positiveSafeInteger(
      "defaultMaxResponseBytes",
      options.defaultMaxResponseBytes ?? 1_048_576,
    );
    this.retryPolicy =
      options.retryPolicy === undefined ? new DefaultRetryPolicy() : options.retryPolicy;
    this.sleep =
      options.sleep === undefined
        ? (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs))
        : options.sleep;
    this.now = options.now === undefined ? performance.now.bind(performance) : options.now;
    this.signalFactory =
      options.signalFactory === undefined
        ? (timeoutMs) => AbortSignal.timeout(timeoutMs)
        : options.signalFactory;
    this.logger = this.createChildLogger(options.logger, {
      component: "http_client",
      upstreamHost: this.baseUrl.host,
    });
    this.tracer = options.tracer === undefined ? new NoopTracer() : options.tracer;
    this.meter = options.meter ?? new NoopMeter();
  }

  async request<TResponse>(
    request: HttpRequest,
    responseSchema: SchemaParser<TResponse>,
  ): Promise<HttpResponse<TResponse>> {
    const normalizedRequest = this.snapshotRequest(request);
    this.assertHttpMethod(normalizedRequest.method);
    this.assertRequestControls(normalizedRequest);
    const requestContext = this.normalizeRequestContext(normalizedRequest.context);
    const parseResponse = this.createResponseParser(responseSchema);

    const url = this.resolveUrl(normalizedRequest.path);
    const fetchImpl = this.getFetchImplementation(url);
    this.assertRuntimeHooks(url);
    const withSpan = this.getTracerWithSpan(url);
    const requestNow = this.createRequestNow(url);
    const startedAt = requestNow();

    return withSpan(
      "http.client.request",
      {
        kind: "client",
        attributes: {
          "http.request.method": normalizedRequest.method,
          "server.address": url.hostname,
          ...(url.port === "" ? {} : { "server.port": Number(url.port) }),
        },
        ...(requestContext === undefined
          ? {}
          : { parent: requestContext.trace, parentIsRemote: false }),
      },
      async (span) => {
        const trace = this.getSpanTraceContext(
          span,
          requestContext?.trace,
          url,
        );
        try {
          const response = await this.executeRequest(
            normalizedRequest,
            requestContext,
            parseResponse,
            fetchImpl,
            url,
            trace,
            startedAt,
            requestNow,
          );
          this.setSpanAttributeBestEffort(
            span,
            "http.response.status_code",
            response.status,
          );
          this.recordClientMetrics(
            normalizedRequest.method,
            url.host,
            "success",
            startedAt,
            requestNow,
            response.status,
          );
          return response;
        } catch (error) {
          const statusCode = this.statusFromError(error);
          if (statusCode !== undefined) {
            this.setSpanAttributeBestEffort(
              span,
              "http.response.status_code",
              statusCode,
            );
          }
          this.setSpanStatusBestEffort(span, "error");
          this.recordClientMetrics(
            normalizedRequest.method,
            url.host,
            "error",
            startedAt,
            requestNow,
            statusCode,
          );
          throw error;
        }
      },
    );
  }

  private async executeRequest<TResponse>(
    request: HttpRequest,
    requestContext: OutboundRequestContext | undefined,
    parseResponse: (value: unknown) => TResponse,
    fetchImpl: FetchLike,
    url: URL,
    trace: TraceContext | undefined,
    startedAt: number,
    requestNow: RequestNow,
  ): Promise<HttpResponse<TResponse>> {
    this.assertRequestBodyAllowed(request, url);
    const headers = this.createRequestHeaders(request.headers, url);
    this.assertApplicationHeaders(headers, url);
    headers.set("accept", "application/json");

    if (requestContext !== undefined) {
      headers.set("x-request-id", requestContext.requestId);
    }
    if (trace) {
      headers.set("traceparent", formatTraceParent(trace));
      const traceState = parseTraceState(trace.traceState);
      if (traceState !== undefined) {
        headers.set("tracestate", traceState);
      }
    }

    const body = this.serializeRequestBody(
      request.body,
      request.maxRequestBytes ?? this.defaultMaxRequestBytes,
      url,
    );
    if (body !== undefined) {
      headers.set("content-type", "application/json");
    }

    const deadlineAt = startedAt + (request.timeoutMs ?? this.defaultTimeoutMs);
    let attempt = 0;

    while (true) {
      const remainingBeforeAttempt = this.remainingMs(deadlineAt, requestNow);
      if (remainingBeforeAttempt <= 0) {
        throw this.timeoutError(url);
      }

      attempt += 1;
      const attemptTimeoutMs = Math.max(
        1,
        Math.ceil(
          Math.min(
            request.attemptTimeoutMs ?? this.defaultAttemptTimeoutMs,
            remainingBeforeAttempt,
          ),
        ),
      );

      try {
        const response = await fetchImpl(url, {
          method: request.method,
          headers,
          ...(body === undefined ? {} : { body }),
          redirect: "manual",
          signal: this.createAttemptSignal(attemptTimeoutMs, url),
        });
        if (!(response instanceof Response)) {
          throw new AppError(
            "INTERNAL_ERROR",
            "Outbound HTTP fetch implementation returned an invalid response",
            500,
            undefined,
            { diagnostics: { host: url.host } },
          );
        }

        if (!response.ok) {
          let retryDelay: number | null;
          try {
            retryDelay = this.nextRetryDelay(
              request,
              attempt,
              {
                kind: "response",
                status: response.status,
                headers: response.headers,
              },
              url,
            );
          } catch (error) {
            this.discardResponseBody(response);
            throw error;
          }

          if (retryDelay !== null && retryDelay < this.remainingMs(deadlineAt, requestNow)) {
            this.discardResponseBody(response);
            this.warnBestEffort("http.client.retry", {
              method: request.method,
              statusCode: response.status,
              attempt,
              nextAttempt: attempt + 1,
              delayMs: retryDelay,
              reason: "status",
              traceId: trace?.traceId,
            });
            if (retryDelay > 0) {
              await this.waitBeforeRetry(retryDelay, url);
            }
            continue;
          }

          this.discardResponseBody(response);
          throw new AppError(
            "UPSTREAM_REQUEST_FAILED",
            "Upstream request failed",
            502,
            undefined,
            { diagnostics: { status: response.status, host: url.host } },
          );
        }

        let raw: unknown;
        try {
          if (request.method === "HEAD" || response.status === 204 || response.status === 205) {
            raw = undefined;
          } else {
            await this.assertJsonResponseContentType(response, url);
            raw = await this.readJsonBody(
              response,
              request.maxResponseBytes ?? this.defaultMaxResponseBytes,
              url,
            );
          }
        } catch (error) {
          if (error instanceof AppError) {
            throw error;
          }
          throw new AppError(
            "UPSTREAM_RESPONSE_INVALID",
            "Upstream returned invalid JSON",
            502,
            undefined,
            { cause: error, diagnostics: { host: url.host } },
          );
        }

        let data: TResponse;
        try {
          data = parseResponse(raw);
        } catch (error) {
          throw new AppError(
            "UPSTREAM_RESPONSE_INVALID",
            "Upstream response did not match the expected schema",
            502,
            undefined,
            { cause: error, diagnostics: { host: url.host } },
          );
        }

        const durationMs = this.readDurationMsBestEffort(startedAt, requestNow);
        this.infoBestEffort("http.client.response", {
          method: request.method,
          statusCode: response.status,
          ...(durationMs === undefined ? {} : { durationMs }),
          attempt,
          traceId: trace?.traceId,
        });
        return { status: response.status, headers: response.headers, data };
      } catch (error) {
        if (!(error instanceof AppError)) {
          const retryDelay = this.nextRetryDelay(request, attempt, { kind: "network" }, url);
          if (retryDelay !== null && retryDelay < this.remainingMs(deadlineAt, requestNow)) {
            this.warnBestEffort("http.client.retry", {
              method: request.method,
              attempt,
              nextAttempt: attempt + 1,
              delayMs: retryDelay,
              reason:
                error instanceof DOMException && error.name === "TimeoutError"
                  ? "timeout"
                  : "network",
              traceId: trace?.traceId,
            });
            if (retryDelay > 0) {
              await this.waitBeforeRetry(retryDelay, url);
            }
            continue;
          }
        }
        if (error instanceof AppError) {
          throw error;
        }
        if (error instanceof DOMException && error.name === "TimeoutError") {
          throw this.timeoutError(url, error);
        }
        throw new AppError(
          "UPSTREAM_REQUEST_FAILED",
          "Upstream request failed",
          502,
          undefined,
          { cause: error, diagnostics: { host: url.host } },
        );
      }
    }
  }

  private getSpanTraceContext(
    span: unknown,
    fallback: TraceContext | undefined,
    url: URL,
  ): TraceContext | undefined {
    if (span === null || (typeof span !== "object" && typeof span !== "function")) {
      throw this.invalidRuntimeHookError("Outbound HTTP tracer span was invalid", url);
    }

    let traceContext: unknown;
    try {
      traceContext = Reflect.get(span, "traceContext");
    } catch {
      throw this.invalidRuntimeHookError("Outbound HTTP tracer span was invalid", url);
    }
    if (typeof traceContext !== "function") {
      throw this.invalidRuntimeHookError("Outbound HTTP tracer span was invalid", url);
    }

    let runtimeTrace: unknown;
    try {
      runtimeTrace = Reflect.apply(traceContext, span, []);
    } catch {
      throw this.invalidRuntimeHookError(
        "Outbound HTTP tracer span trace context was invalid",
        url,
      );
    }
    if (runtimeTrace === undefined) {
      return fallback;
    }

    const normalized = this.normalizeTraceContext(runtimeTrace);
    if (normalized === null) {
      throw this.invalidRuntimeHookError(
        "Outbound HTTP tracer span trace context was invalid",
        url,
      );
    }
    return normalized;
  }

  private normalizeTraceContext(value: unknown): TraceContext | null {
    if (value === null || (typeof value !== "object" && typeof value !== "function")) {
      return null;
    }

    try {
      const traceId = Reflect.get(value, "traceId");
      const spanId = Reflect.get(value, "spanId");
      const traceFlags = Reflect.get(value, "traceFlags");
      const traceState = Reflect.get(value, "traceState");
      if (
        typeof traceId !== "string" ||
        typeof spanId !== "string" ||
        typeof traceFlags !== "string" ||
        (traceState !== undefined && typeof traceState !== "string")
      ) {
        return null;
      }

      if (parseTraceParent(`00-${traceId}-${spanId}-${traceFlags}`) === null) {
        return null;
      }

      return traceState === undefined
        ? { traceId, spanId, traceFlags }
        : { traceId, spanId, traceFlags, traceState };
    } catch {
      return null;
    }
  }

  private setSpanAttributeBestEffort(
    span: unknown,
    name: string,
    value: TelemetryAttributeValue,
  ): void {
    this.invokeSpanMutationBestEffort(span, "setAttribute", [name, value]);
  }

  private setSpanStatusBestEffort(span: unknown, status: SpanStatus): void {
    this.invokeSpanMutationBestEffort(span, "setStatus", [status]);
  }

  private invokeSpanMutationBestEffort(
    span: unknown,
    method: "setAttribute" | "setStatus",
    args: readonly unknown[],
  ): void {
    if (span === null || (typeof span !== "object" && typeof span !== "function")) {
      return;
    }

    try {
      const mutation = Reflect.get(span, method);
      if (typeof mutation !== "function") {
        return;
      }
      Reflect.apply(mutation, span, args);
    } catch {
      // Telemetry annotation is observational and must not replace the HTTP result.
    }
  }

  private getTracerWithSpan(url: URL): Tracer["withSpan"] {
    const tracer = this.tracer as unknown;
    if (
      tracer === null ||
      (typeof tracer !== "object" && typeof tracer !== "function")
    ) {
      throw this.invalidRuntimeHookError("Outbound HTTP tracer was invalid", url);
    }

    let withSpan: unknown;
    try {
      withSpan = Reflect.get(tracer, "withSpan");
    } catch {
      throw this.invalidRuntimeHookError("Outbound HTTP tracer was invalid", url);
    }
    if (typeof withSpan !== "function") {
      throw this.invalidRuntimeHookError("Outbound HTTP tracer was invalid", url);
    }

    return withSpan.bind(tracer) as Tracer["withSpan"];
  }

  private assertRuntimeHooks(url: URL): void {
    const retryPolicy = this.retryPolicy as unknown;
    if (
      retryPolicy === null ||
      (typeof retryPolicy !== "object" && typeof retryPolicy !== "function")
    ) {
      throw this.invalidRuntimeHookError("Outbound HTTP retry policy was invalid", url);
    }

    let nextDelay: unknown;
    try {
      nextDelay = Reflect.get(retryPolicy, "nextDelay");
    } catch {
      throw this.invalidRuntimeHookError("Outbound HTTP retry policy was invalid", url);
    }
    if (typeof nextDelay !== "function") {
      throw this.invalidRuntimeHookError("Outbound HTTP retry policy was invalid", url);
    }

    if (typeof (this.sleep as unknown) !== "function") {
      throw this.invalidRuntimeHookError("Outbound HTTP retry sleep hook was invalid", url);
    }
    if (typeof (this.now as unknown) !== "function") {
      throw this.invalidRuntimeHookError("Outbound HTTP monotonic clock hook was invalid", url);
    }
    if (typeof (this.signalFactory as unknown) !== "function") {
      throw this.invalidRuntimeHookError(
        "Outbound HTTP timeout signal factory was invalid",
        url,
      );
    }
  }

  private invalidRuntimeHookError(message: string, url: URL): AppError {
    return new AppError(
      "INTERNAL_ERROR",
      message,
      500,
      undefined,
      { diagnostics: { host: url.host } },
    );
  }

  private getFetchImplementation(url: URL): FetchLike {
    if (typeof this.fetchImpl !== "function") {
      throw new AppError(
        "INTERNAL_ERROR",
        "Outbound HTTP fetch implementation was invalid",
        500,
        undefined,
        { diagnostics: { host: url.host } },
      );
    }
    return this.fetchImpl as FetchLike;
  }

  private createResponseParser<TResponse>(
    responseSchema: SchemaParser<TResponse>,
  ): (value: unknown) => TResponse {
    const candidate = responseSchema as unknown;
    if (
      candidate === null ||
      (typeof candidate !== "object" && typeof candidate !== "function")
    ) {
      throw this.invalidResponseSchemaError();
    }

    let parse: unknown;
    try {
      parse = Reflect.get(candidate, "parse");
    } catch {
      throw this.invalidResponseSchemaError();
    }
    if (typeof parse !== "function") {
      throw this.invalidResponseSchemaError();
    }

    return (value) => Reflect.apply(parse, candidate, [value]) as TResponse;
  }

  private invalidResponseSchemaError(): AppError {
    return new AppError(
      "INTERNAL_ERROR",
      "Outbound HTTP response schema was invalid",
      500,
      undefined,
      { diagnostics: { host: this.baseUrl.host } },
    );
  }

  private snapshotRequest(request: unknown): HttpRequest {
    if (typeof request !== "object" || request === null || Array.isArray(request)) {
      throw this.invalidRequestShapeError();
    }

    try {
      const method = Reflect.get(request, "method") as HttpRequest["method"];
      const path = Reflect.get(request, "path") as HttpRequest["path"];
      const headers = Reflect.get(request, "headers") as HttpRequest["headers"];
      const body = Reflect.get(request, "body") as unknown;
      const maxRequestBytes = Reflect.get(
        request,
        "maxRequestBytes",
      ) as HttpRequest["maxRequestBytes"];
      const timeoutMs = Reflect.get(request, "timeoutMs") as HttpRequest["timeoutMs"];
      const attemptTimeoutMs = Reflect.get(
        request,
        "attemptTimeoutMs",
      ) as HttpRequest["attemptTimeoutMs"];
      const maxResponseBytes = Reflect.get(
        request,
        "maxResponseBytes",
      ) as HttpRequest["maxResponseBytes"];
      const retry = Reflect.get(request, "retry") as HttpRequest["retry"];
      const context = Reflect.get(request, "context") as HttpRequest["context"];

      return {
        method,
        path,
        ...(headers === undefined ? {} : { headers }),
        ...(body === undefined ? {} : { body }),
        ...(maxRequestBytes === undefined ? {} : { maxRequestBytes }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(attemptTimeoutMs === undefined ? {} : { attemptTimeoutMs }),
        ...(maxResponseBytes === undefined ? {} : { maxResponseBytes }),
        ...(retry === undefined ? {} : { retry }),
        ...(context === undefined ? {} : { context }),
      };
    } catch {
      throw this.invalidRequestShapeError();
    }
  }

  private invalidRequestShapeError(): AppError {
    return new AppError(
      "INTERNAL_ERROR",
      "Outbound HTTP request was invalid",
      500,
      undefined,
      { diagnostics: { host: this.baseUrl.host } },
    );
  }

  private assertHttpMethod(method: unknown): asserts method is HttpMethod {
    if (typeof method !== "string" || !OUTBOUND_HTTP_METHODS.has(method as HttpMethod)) {
      throw new AppError(
        "INTERNAL_ERROR",
        "Outbound HTTP method was invalid",
        500,
      );
    }
  }

  private normalizeRequestContext(context: unknown): OutboundRequestContext | undefined {
    if (context === undefined) {
      return undefined;
    }

    if (typeof context !== "object" || context === null || Array.isArray(context)) {
      throw this.invalidRequestContextError();
    }

    let requestId: unknown;
    let runtimeTrace: unknown;
    try {
      requestId = Reflect.get(context, "requestId");
      runtimeTrace = Reflect.get(context, "trace");
    } catch {
      throw this.invalidRequestContextError();
    }

    if (
      typeof requestId !== "string" ||
      !/^[\x21-\x7e]{1,128}$/.test(requestId) ||
      typeof runtimeTrace !== "object" ||
      runtimeTrace === null ||
      Array.isArray(runtimeTrace)
    ) {
      throw this.invalidRequestContextError();
    }

    let traceId: unknown;
    let spanId: unknown;
    let traceFlags: unknown;
    let traceState: unknown;
    try {
      traceId = Reflect.get(runtimeTrace, "traceId");
      spanId = Reflect.get(runtimeTrace, "spanId");
      traceFlags = Reflect.get(runtimeTrace, "traceFlags");
      traceState = Reflect.get(runtimeTrace, "traceState");
    } catch {
      throw this.invalidRequestContextError();
    }

    if (
      typeof traceId !== "string" ||
      typeof spanId !== "string" ||
      typeof traceFlags !== "string" ||
      (traceState !== undefined && typeof traceState !== "string")
    ) {
      throw this.invalidRequestContextError();
    }

    if (parseTraceParent(`00-${traceId}-${spanId}-${traceFlags}`) === null) {
      throw this.invalidRequestContextError();
    }

    const normalizedTraceState =
      traceState === undefined ? undefined : parseTraceState(traceState);

    return {
      requestId,
      trace:
        normalizedTraceState === undefined
          ? { traceId, spanId, traceFlags }
          : { traceId, spanId, traceFlags, traceState: normalizedTraceState },
    };
  }

  private invalidRequestContextError(): AppError {
    return new AppError(
      "INTERNAL_ERROR",
      "Outbound HTTP request context was invalid",
      500,
      undefined,
      { diagnostics: { host: this.baseUrl.host } },
    );
  }

  private assertRequestControls(request: HttpRequest): void {
    if (
      request.retry !== undefined &&
      request.retry !== "never" &&
      request.retry !== "idempotent"
    ) {
      throw new AppError(
        "INTERNAL_ERROR",
        "Outbound HTTP retry mode was invalid",
        500,
        undefined,
        { diagnostics: { host: this.baseUrl.host } },
      );
    }

    try {
      if (request.timeoutMs !== undefined) {
        positiveFiniteNumber("timeoutMs", request.timeoutMs);
      }
      if (request.attemptTimeoutMs !== undefined) {
        positiveFiniteNumber("attemptTimeoutMs", request.attemptTimeoutMs);
      }
      if (request.maxRequestBytes !== undefined) {
        positiveSafeInteger("maxRequestBytes", request.maxRequestBytes);
      }
      if (request.maxResponseBytes !== undefined) {
        positiveSafeInteger("maxResponseBytes", request.maxResponseBytes);
      }
    } catch {
      throw new AppError(
        "INTERNAL_ERROR",
        "Outbound HTTP request controls were invalid",
        500,
        undefined,
        { diagnostics: { host: this.baseUrl.host } },
      );
    }
  }

  private assertRequestBodyAllowed(request: HttpRequest, url: URL): void {
    if ((request.method === "GET" || request.method === "HEAD") && request.body !== undefined) {
      throw new AppError(
        "INTERNAL_ERROR",
        "Outbound HTTP GET/HEAD requests cannot include a body",
        500,
        undefined,
        { diagnostics: { host: url.host } },
      );
    }
  }

  private createRequestHeaders(input: HeadersInit | undefined, url: URL): Headers {
    try {
      return new Headers(input);
    } catch {
      throw new AppError(
        "INTERNAL_ERROR",
        "Outbound HTTP request headers were invalid",
        500,
        undefined,
        { diagnostics: { host: url.host } },
      );
    }
  }

  private assertApplicationHeaders(headers: Headers, url: URL): void {
    for (const name of TRANSPORT_OWNED_REQUEST_HEADERS) {
      if (!headers.has(name)) {
        continue;
      }
      throw new AppError(
        "INTERNAL_ERROR",
        "Outbound HTTP request included transport-owned headers",
        500,
        undefined,
        { diagnostics: { host: url.host } },
      );
    }
  }

  private serializeRequestBody(
    body: unknown,
    maxRequestBytes: number,
    url: URL,
  ): string | undefined {
    if (body === undefined) {
      return undefined;
    }

    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(body);
    } catch (error) {
      throw new AppError(
        "INTERNAL_ERROR",
        "Outbound HTTP request body could not be serialized",
        500,
        undefined,
        { cause: error, diagnostics: { host: url.host } },
      );
    }

    if (serialized === undefined) {
      throw new AppError(
        "INTERNAL_ERROR",
        "Outbound HTTP request body could not be serialized",
        500,
        undefined,
        { diagnostics: { host: url.host } },
      );
    }

    if (new TextEncoder().encode(serialized).byteLength > maxRequestBytes) {
      throw new AppError(
        "INTERNAL_ERROR",
        "Outbound HTTP request body exceeded maximum size",
        500,
        undefined,
        { diagnostics: { host: url.host } },
      );
    }

    return serialized;
  }

  private async assertJsonResponseContentType(response: Response, url: URL): Promise<void> {
    const contentType = response.headers.get("content-type");
    if (contentType === null || hasAmbiguousContentTypeValue(contentType)) {
      this.discardResponseBody(response);
      throw new AppError(
        "UPSTREAM_RESPONSE_INVALID",
        "Upstream response did not use a JSON media type",
        502,
        undefined,
        { diagnostics: { host: url.host } },
      );
    }

    const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
    const isJson =
      mediaType === "application/json" ||
      (mediaType !== undefined &&
        /^application\/[!#$%&'*+.^_`|~0-9a-z-]+\+json$/.test(mediaType));

    if (isJson) {
      return;
    }

    this.discardResponseBody(response);
    throw new AppError(
      "UPSTREAM_RESPONSE_INVALID",
      "Upstream response did not use a JSON media type",
      502,
      undefined,
      { diagnostics: { host: url.host } },
    );
  }

  private async readJsonBody(
    response: Response,
    maxResponseBytes: number,
    url: URL,
  ): Promise<unknown> {
    if (response.body === null) {
      return JSON.parse("");
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        totalBytes += value.byteLength;
        if (totalBytes > maxResponseBytes) {
          this.cancelReaderBestEffort(reader);
          throw new AppError(
            "UPSTREAM_RESPONSE_INVALID",
            "Upstream response exceeded maximum size",
            502,
            undefined,
            { diagnostics: { host: url.host } },
          );
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }

    const body = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  }

  private cancelReaderBestEffort(reader: ReadableStreamDefaultReader<Uint8Array>): void {
    try {
      void reader.cancel().catch(() => undefined);
    } catch {
      // Cleanup is best-effort and must not delay or replace the size violation.
    }
  }

  private discardResponseBody(response: Response): void {
    if (response.body === null || response.bodyUsed) {
      return;
    }
    try {
      void response.body.cancel().catch(() => undefined);
    } catch {
      // Cleanup is best-effort and must not delay or replace the upstream failure.
    }
  }

  private createAttemptSignal(timeoutMs: number, url: URL): AbortSignal {
    let signal: unknown;
    try {
      signal = this.signalFactory(timeoutMs);
    } catch (error) {
      throw new AppError(
        "INTERNAL_ERROR",
        "Outbound HTTP timeout signal factory failed",
        500,
        undefined,
        { cause: error, diagnostics: { host: url.host } },
      );
    }

    if (!(signal instanceof AbortSignal)) {
      throw new AppError(
        "INTERNAL_ERROR",
        "Outbound HTTP timeout signal factory returned an invalid signal",
        500,
        undefined,
        { diagnostics: { host: url.host } },
      );
    }
    return signal;
  }

  private async waitBeforeRetry(delayMs: number, url: URL): Promise<void> {
    try {
      await this.sleep(delayMs);
    } catch (error) {
      throw new AppError(
        "INTERNAL_ERROR",
        "Outbound HTTP retry delay failed",
        500,
        undefined,
        { cause: error, diagnostics: { host: url.host } },
      );
    }
  }

  private nextRetryDelay(
    request: HttpRequest,
    attempt: number,
    failure: Parameters<RetryPolicy["nextDelay"]>[2],
    url: URL,
  ): number | null {
    let delay: number | null;
    try {
      delay = this.retryPolicy.nextDelay(request, attempt, failure);
    } catch (error) {
      throw new AppError(
        "INTERNAL_ERROR",
        "Outbound HTTP retry policy failed",
        500,
        undefined,
        { cause: error, diagnostics: { host: url.host } },
      );
    }

    if (delay === null) {
      return null;
    }
    if (!Number.isFinite(delay) || delay < 0) {
      throw new AppError(
        "INTERNAL_ERROR",
        "Outbound HTTP retry policy returned an invalid delay",
        500,
        undefined,
        { diagnostics: { host: url.host } },
      );
    }
    return delay;
  }

  private recordClientMetrics(
    method: HttpMethod,
    upstream: string,
    outcome: "success" | "error",
    startedAt: number,
    requestNow: RequestNow,
    statusCode?: number,
  ): void {
    const attributes = {
      method,
      upstream,
      outcome,
      ...(statusCode === undefined ? {} : { status_code: statusCode }),
    } as const;
    try {
      this.meter.increment("http.client.requests", 1, attributes);
    } catch {
      // Observability is best-effort and must not replace the HTTP result.
    }

    const durationMs = this.readDurationMsBestEffort(startedAt, requestNow);
    if (durationMs === undefined) {
      return;
    }
    try {
      this.meter.record("http.client.duration", durationMs / 1_000, attributes);
    } catch {
      // Observability is best-effort and must not replace the HTTP result.
    }
  }

  private readDurationMsBestEffort(
    startedAt: number,
    requestNow: RequestNow,
  ): number | undefined {
    try {
      return Number((requestNow() - startedAt).toFixed(2));
    } catch {
      return undefined;
    }
  }

  private createChildLogger(logger: unknown, context: LogContext): Logger {
    if (logger === null || (typeof logger !== "object" && typeof logger !== "function")) {
      throw new TypeError(
        "FetchHttpClient logger must provide a callable child() method",
      );
    }

    let childFactory: unknown;
    try {
      childFactory = Reflect.get(logger, "child");
    } catch {
      throw new TypeError(
        "FetchHttpClient logger must provide a callable child() method",
      );
    }
    if (typeof childFactory !== "function") {
      throw new TypeError(
        "FetchHttpClient logger must provide a callable child() method",
      );
    }

    let child: unknown;
    try {
      child = Reflect.apply(childFactory, logger, [context]);
    } catch {
      throw new TypeError("FetchHttpClient logger.child() failed");
    }

    if (child === null || (typeof child !== "object" && typeof child !== "function")) {
      throw new TypeError(
        "FetchHttpClient logger.child() must return callable info() and warn() methods",
      );
    }

    let info: unknown;
    let warn: unknown;
    try {
      info = Reflect.get(child, "info");
      warn = Reflect.get(child, "warn");
    } catch {
      throw new TypeError(
        "FetchHttpClient logger.child() must return callable info() and warn() methods",
      );
    }
    if (typeof info !== "function" || typeof warn !== "function") {
      throw new TypeError(
        "FetchHttpClient logger.child() must return callable info() and warn() methods",
      );
    }

    return child as Logger;
  }

  private infoBestEffort(message: string, context: LogContext): void {
    try {
      this.logger.info(message, context);
    } catch {
      // Logging is best-effort and must not replace or replay the HTTP result.
    }
  }

  private warnBestEffort(message: string, context: LogContext): void {
    try {
      this.logger.warn(message, context);
    } catch {
      // Logging is best-effort and must not replace or replay the HTTP result.
    }
  }

  private statusFromError(error: unknown): number | undefined {
    if (
      !(error instanceof AppError) ||
      typeof error.diagnostics !== "object" ||
      error.diagnostics === null
    ) {
      return undefined;
    }
    const status = "status" in error.diagnostics ? error.diagnostics.status : undefined;
    return typeof status === "number" ? status : undefined;
  }

  private timeoutError(url: URL, cause?: unknown): AppError {
    return new AppError(
      "UPSTREAM_TIMEOUT",
      "Upstream request timed out",
      504,
      undefined,
      {
        ...(cause === undefined ? {} : { cause }),
        diagnostics: { host: url.host },
      },
    );
  }

  private remainingMs(deadlineAt: number, requestNow: RequestNow): number {
    return Math.max(0, deadlineAt - requestNow());
  }

  private createRequestNow(url: URL): RequestNow {
    let last: number | undefined;

    return () => {
      let current: number;
      try {
        current = this.now();
      } catch (error) {
        throw new AppError(
          "INTERNAL_ERROR",
          "Outbound HTTP monotonic clock failed",
          500,
          undefined,
          { cause: error, diagnostics: { host: url.host } },
        );
      }

      if (!Number.isFinite(current) || (last !== undefined && current < last)) {
        throw new AppError(
          "INTERNAL_ERROR",
          "Outbound HTTP monotonic clock returned an invalid timestamp",
          500,
          undefined,
          { diagnostics: { host: url.host } },
        );
      }

      last = current;
      return current;
    };
  }

  private resolveUrl(path: string): URL {
    if (
      typeof path !== "string" ||
      !path.startsWith("/") ||
      path.startsWith("//") ||
      path.includes("\\") ||
      path.includes("#") ||
      hasRawUrlControlCharacters(path) ||
      hasDotPathSegment(path) ||
      /^[a-z][a-z0-9+.-]*:/i.test(path)
    ) {
      throw this.invalidHttpPath();
    }

    const url = new URL(path, this.baseUrl);
    if (url.origin !== this.baseUrl.origin) {
      throw this.invalidHttpPath();
    }
    return url;
  }

  private invalidHttpPath(): AppError {
    return new AppError(
      "INVALID_HTTP_PATH",
      "HttpClient path must be an absolute path on the configured upstream host",
      400,
    );
  }
}
