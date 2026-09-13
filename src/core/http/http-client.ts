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
  readonly timeoutMs?: number;
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
