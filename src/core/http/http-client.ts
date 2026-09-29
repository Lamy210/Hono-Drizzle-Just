import type { RequestContext } from "../context/request-context";

export type HttpMethod = "GET" | "HEAD" | "OPTIONS" | "POST" | "PUT" | "PATCH" | "DELETE";
export type HttpRetryMode = "never" | "idempotent";

export interface SchemaParser<T> {
  parse(value: unknown): T;
}

export interface HttpRequest<TBody = unknown> {
  readonly method: HttpMethod;
  readonly path: string;
  readonly headers?: HeadersInit;
  readonly body?: TBody;
  /** Maximum serialized JSON request-body bytes before any network attempt. */
  readonly maxRequestBytes?: number;
  /** Total time budget across attempts, retry delays, and response handling. */
  readonly timeoutMs?: number;
  /** Maximum time budget for one network attempt. */
  readonly attemptTimeoutMs?: number;
  /** Maximum successful response-body bytes read before validation. */
  readonly maxResponseBytes?: number;
  readonly retry?: HttpRetryMode;
  readonly context?: RequestContext;
}

export interface HttpResponse<T> {
  readonly status: number;
  readonly headers: Headers;
  readonly data: T;
}

export interface HttpClient {
  request<TResponse>(
    request: HttpRequest,
    responseSchema: SchemaParser<TResponse>,
  ): Promise<HttpResponse<TResponse>>;
}
