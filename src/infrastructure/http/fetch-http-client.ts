import type { TraceContext } from "../../core/tracing/trace-context";
import { AppError } from "../../core/errors/app-error";
import type {
  HttpClient,
  HttpMethod,
  HttpRequest,
  HttpResponse,
  SchemaParser,
} from "../../core/http/http-client";
import type { Logger } from "../../core/logging/logger";
import type { Meter } from "../../core/observability/meter";
import { NoopMeter } from "../../core/observability/noop-meter";
import { NoopTracer } from "../../core/observability/noop-tracer";
import type { Tracer } from "../../core/observability/tracer";
import { DefaultRetryPolicy, type RetryPolicy } from "./retry-policy";
import { formatTraceParent } from "../tracing/w3c-trace-context";

function positiveFiniteNumber(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a finite number greater than 0`);
  }
  return value;
}

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

export type FetchLike = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => ReturnType<typeof fetch>;

export type SleepLike = (delayMs: number) => Promise<void>;
export type MonotonicNow = () => number;
export type TimeoutSignalFactory = (timeoutMs: number) => AbortSignal;

export interface FetchHttpClientOptions {
  readonly baseUrl: string | URL;
  readonly logger: Logger;
  readonly fetchImpl?: FetchLike;
  /** Total time budget across attempts and retry delays. */
  readonly defaultTimeoutMs?: number;
  /** Maximum time budget for one fetch attempt. */
  readonly defaultAttemptTimeoutMs?: number;
  readonly retryPolicy?: RetryPolicy;
  readonly sleep?: SleepLike;
  readonly now?: MonotonicNow;
  readonly signalFactory?: TimeoutSignalFactory;
  readonly tracer?: Tracer;
  readonly meter?: Meter;
}

export class FetchHttpClient implements HttpClient {
  private readonly baseUrl: URL;
  private readonly fetchImpl: FetchLike;
  private readonly defaultTimeoutMs: number;
  private readonly defaultAttemptTimeoutMs: number;
  private readonly retryPolicy: RetryPolicy;
  private readonly sleep: SleepLike;
  private readonly now: MonotonicNow;
  private readonly signalFactory: TimeoutSignalFactory;
  private readonly logger: Logger;
  private readonly tracer: Tracer;
  private readonly meter: Meter;

  constructor(options: FetchHttpClientOptions) {
    this.baseUrl = parseBaseUrl(options.baseUrl);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.defaultTimeoutMs = positiveFiniteNumber(
      "defaultTimeoutMs",
      options.defaultTimeoutMs ?? 10_000,
    );
    this.defaultAttemptTimeoutMs = positiveFiniteNumber(
      "defaultAttemptTimeoutMs",
      options.defaultAttemptTimeoutMs ?? 3_000,
    );
    this.retryPolicy = options.retryPolicy ?? new DefaultRetryPolicy();
    this.sleep = options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
    this.now = options.now ?? performance.now.bind(performance);
    this.signalFactory = options.signalFactory ?? ((timeoutMs) => AbortSignal.timeout(timeoutMs));
    this.logger = options.logger.child({ component: "http_client", upstreamHost: this.baseUrl.host });
    this.tracer = options.tracer ?? new NoopTracer();
    this.meter = options.meter ?? new NoopMeter();
  }

  async request<TResponse>(
    request: HttpRequest,
    responseSchema: SchemaParser<TResponse>,
  ): Promise<HttpResponse<TResponse>> {
    if (request.timeoutMs !== undefined) {
      positiveFiniteNumber("timeoutMs", request.timeoutMs);
    }
    if (request.attemptTimeoutMs !== undefined) {
      positiveFiniteNumber("attemptTimeoutMs", request.attemptTimeoutMs);
    }

    const url = this.resolveUrl(request.path);
    const startedAt = this.now();

    return this.tracer.withSpan(
      "http.client.request",
      {
        kind: "client",
        attributes: {
          "http.request.method": request.method,
          "server.address": url.hostname,
          ...(url.port === "" ? {} : { "server.port": Number(url.port) }),
        },
        ...(request.context === undefined
          ? {}
          : { parent: request.context.trace, parentIsRemote: false }),
      },
      async (span) => {
        const trace = span.traceContext() ?? request.context?.trace;
        try {
          const response = await this.executeRequest(
            request,
            responseSchema,
            url,
            trace,
            startedAt,
          );
          span.setAttribute("http.response.status_code", response.status);
          this.recordClientMetrics(request.method, url.host, "success", startedAt, response.status);
          return response;
        } catch (error) {
          const statusCode = this.statusFromError(error);
          if (statusCode !== undefined) {
            span.setAttribute("http.response.status_code", statusCode);
          }
          span.setStatus("error");
          this.recordClientMetrics(request.method, url.host, "error", startedAt, statusCode);
          throw error;
        }
      },
    );
  }

  private async executeRequest<TResponse>(
    request: HttpRequest,
    responseSchema: SchemaParser<TResponse>,
    url: URL,
    trace: TraceContext | undefined,
    startedAt: number,
  ): Promise<HttpResponse<TResponse>> {
    const headers = new Headers(request.headers);
    headers.set("accept", "application/json");

    if (request.context) {
      headers.set("x-request-id", request.context.requestId);
    }
    if (trace) {
      headers.set("traceparent", formatTraceParent(trace));
      if (trace.traceState) {
        headers.set("tracestate", trace.traceState);
      }
    }

    const body = request.body === undefined ? undefined : JSON.stringify(request.body);
    if (body !== undefined) {
      headers.set("content-type", "application/json");
    }

    const deadlineAt = startedAt + (request.timeoutMs ?? this.defaultTimeoutMs);
    let attempt = 0;

    while (true) {
      const remainingBeforeAttempt = this.remainingMs(deadlineAt);
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
        const response = await this.fetchImpl(url, {
          method: request.method,
          headers,
          ...(body === undefined ? {} : { body }),
          redirect: "manual",
          signal: this.signalFactory(attemptTimeoutMs),
        });

        const retryDelay = this.retryPolicy.nextDelay(request, attempt, {
          kind: "response",
          status: response.status,
          headers: response.headers,
        });
        if (retryDelay !== null && retryDelay < this.remainingMs(deadlineAt)) {
          this.logger.warn("http.client.retry", {
            method: request.method,
            path: url.pathname,
            statusCode: response.status,
            attempt,
            nextAttempt: attempt + 1,
            delayMs: retryDelay,
            reason: "status",
            traceId: trace?.traceId,
          });
          if (retryDelay > 0) {
            await this.sleep(retryDelay);
          }
          continue;
        }

        if (!response.ok) {
          throw new AppError(
            "UPSTREAM_REQUEST_FAILED",
            `Upstream returned HTTP ${response.status}`,
            502,
            { status: response.status, host: url.host },
          );
        }

        let raw: unknown;
        try {
          raw = request.method === "HEAD" || response.status === 204 ? undefined : await response.json();
        } catch (error) {
          throw new AppError(
            "UPSTREAM_RESPONSE_INVALID",
            "Upstream returned invalid JSON",
            502,
            { host: url.host },
            { cause: error },
          );
        }

        let data: TResponse;
        try {
          data = responseSchema.parse(raw);
        } catch (error) {
          throw new AppError(
            "UPSTREAM_RESPONSE_INVALID",
            "Upstream response did not match the expected schema",
            502,
            { host: url.host },
            { cause: error },
          );
        }

        this.logger.info("http.client.response", {
          method: request.method,
          path: url.pathname,
          statusCode: response.status,
          durationMs: Number((this.now() - startedAt).toFixed(2)),
          attempt,
          traceId: trace?.traceId,
        });
        return { status: response.status, headers: response.headers, data };
      } catch (error) {
        if (!(error instanceof AppError)) {
          const retryDelay = this.retryPolicy.nextDelay(request, attempt, { kind: "network" });
          if (retryDelay !== null && retryDelay < this.remainingMs(deadlineAt)) {
            this.logger.warn("http.client.retry", {
              method: request.method,
              path: url.pathname,
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
              await this.sleep(retryDelay);
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
          { host: url.host },
          { cause: error },
        );
      }
    }
  }

  private recordClientMetrics(
    method: HttpMethod,
    upstream: string,
    outcome: "success" | "error",
    startedAt: number,
    statusCode?: number,
  ): void {
    const attributes = {
      method,
      upstream,
      outcome,
      ...(statusCode === undefined ? {} : { status_code: statusCode }),
    } as const;
    this.meter.increment("http.client.requests", 1, attributes);
    this.meter.record(
      "http.client.duration",
      Math.max(0, this.now() - startedAt) / 1_000,
      attributes,
    );
  }

  private statusFromError(error: unknown): number | undefined {
    if (!(error instanceof AppError) || typeof error.details !== "object" || error.details === null) {
      return undefined;
    }
    const status = "status" in error.details ? error.details.status : undefined;
    return typeof status === "number" ? status : undefined;
  }

  private timeoutError(url: URL, cause?: unknown): AppError {
    return new AppError(
      "UPSTREAM_TIMEOUT",
      "Upstream request timed out",
      504,
      { host: url.host },
      cause === undefined ? undefined : { cause },
    );
  }

  private remainingMs(deadlineAt: number): number {
    return Math.max(0, deadlineAt - this.now());
  }

  private resolveUrl(path: string): URL {
    if (!path.startsWith("/") || path.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(path)) {
      throw new AppError(
        "INVALID_HTTP_PATH",
        "HttpClient path must be an absolute path on the configured upstream host",
        400,
      );
    }
    return new URL(path, this.baseUrl);
  }
}
