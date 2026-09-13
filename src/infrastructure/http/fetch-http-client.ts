import { AppError } from "../../core/errors/app-error";
import type {
  HttpClient,
  HttpRequest,
  HttpResponse,
  SchemaParser,
} from "../../core/http/http-client";
import type { Logger } from "../../core/logging/logger";
import { formatTraceParent } from "../tracing/w3c-trace-context";

const RETRYABLE_STATUS_CODES = new Set([408, 429, 502, 503, 504]);
const DEFAULT_RETRY_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export type FetchLike = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => ReturnType<typeof fetch>;

export interface FetchHttpClientOptions {
  readonly baseUrl: string | URL;
  readonly logger: Logger;
  readonly fetchImpl?: FetchLike;
  readonly defaultTimeoutMs?: number;
}

export class FetchHttpClient implements HttpClient {
  private readonly baseUrl: URL;
  private readonly fetchImpl: FetchLike;
  private readonly defaultTimeoutMs: number;
  private readonly logger: Logger;

  constructor(options: FetchHttpClientOptions) {
    this.baseUrl = new URL(options.baseUrl);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 10_000;
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

    const startedAt = performance.now();
    let attempt = 0;

    while (true) {
      attempt += 1;
      try {
        const response = await this.fetchImpl(url, {
          method: request.method,
          headers,
          ...(body === undefined ? {} : { body }),
          signal: AbortSignal.timeout(request.timeoutMs ?? this.defaultTimeoutMs),
        });

        if (
          RETRYABLE_STATUS_CODES.has(response.status) &&
          this.canRetry(request) &&
          attempt === 1
        ) {
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
          raw = response.status === 204 ? undefined : await response.json();
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
          durationMs: Number((performance.now() - startedAt).toFixed(2)),
          traceId: request.context?.trace.traceId,
        });
        return { status: response.status, headers: response.headers, data };
      } catch (error) {
        if (!(error instanceof AppError) && this.canRetry(request) && attempt === 1) {
          continue;
        }
        if (error instanceof AppError) {
          throw error;
        }
        if (error instanceof DOMException && error.name === "TimeoutError") {
          throw new AppError(
            "UPSTREAM_TIMEOUT",
            "Upstream request timed out",
            504,
            { host: url.host },
            { cause: error },
          );
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

  private canRetry(request: HttpRequest): boolean {
    return request.retry === "idempotent" || DEFAULT_RETRY_METHODS.has(request.method);
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
