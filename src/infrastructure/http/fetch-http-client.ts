import { AppError } from "../../core/errors/app-error";
import type {
  HttpClient,
  HttpRequest,
  HttpResponse,
  SchemaParser,
} from "../../core/http/http-client";
import type { Logger } from "../../core/logging/logger";
import { DefaultRetryPolicy, type RetryPolicy } from "./retry-policy";
import { formatTraceParent } from "../tracing/w3c-trace-context";

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

  constructor(options: FetchHttpClientOptions) {
    this.baseUrl = new URL(options.baseUrl);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 10_000;
    this.defaultAttemptTimeoutMs = options.defaultAttemptTimeoutMs ?? 3_000;
    this.retryPolicy = options.retryPolicy ?? new DefaultRetryPolicy();
    this.sleep = options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
    this.now = options.now ?? performance.now.bind(performance);
    this.signalFactory = options.signalFactory ?? ((timeoutMs) => AbortSignal.timeout(timeoutMs));
    this.logger = options.logger.child({ component: "http_client", upstreamHost: this.baseUrl.host });
  }

  async request<TResponse>(
    request: HttpRequest,
    responseSchema: SchemaParser<TResponse>,
  ): Promise<HttpResponse<TResponse>> {
    const url = this.resolveUrl(request.path);
    const headers = new Headers(request.headers);
    headers.set("accept", "application/json");

    if (request.context) {
      headers.set("x-request-id", request.context.requestId);
      headers.set("traceparent", formatTraceParent(request.context.trace));
      if (request.context.trace.traceState) {
        headers.set("tracestate", request.context.trace.traceState);
      }
    }

    const body = request.body === undefined ? undefined : JSON.stringify(request.body);
    if (body !== undefined) {
      headers.set("content-type", "application/json");
    }

    const startedAt = this.now();
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
            traceId: request.context?.trace.traceId,
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
          traceId: request.context?.trace.traceId,
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
              traceId: request.context?.trace.traceId,
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
