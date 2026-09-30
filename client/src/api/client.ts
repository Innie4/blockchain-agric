import { ApiError, toApiErrorCode } from "./errors";
import type { ErrorEnvelope, SuccessEnvelope } from "./types";
import { isDemoDataEnabled } from "../demo/mode";
import { DemoRouteNotFound, demoRequest } from "../demo/router";

/** The readable companion to the `httpOnly` session cookie. */
export const CSRF_COOKIE_NAME = "agri_csrf";
export const CSRF_HEADER_NAME = "x-csrf-token";

export const HTTP_METHODS = ["GET", "POST", "PATCH", "PUT", "DELETE"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export type QueryValue = string | number | boolean | undefined | null;
export type QueryParams = Record<string, QueryValue>;

export interface RequestOptions {
  /** JSON body. Mutually exclusive with `formData`. */
  body?: unknown;
  /** Multipart body. The browser sets the boundary, so no content type here. */
  formData?: FormData;
  query?: QueryParams;
  signal?: AbortSignal;
  /** Sent as `Idempotency-Key` so a retry cannot create a second record. */
  idempotencyKey?: string;
}

export interface DownloadOptions {
  method?: HttpMethod;
  query?: QueryParams;
  signal?: AbortSignal;
}

const DEFAULT_BASE_URL = "/api";
const SAFE_METHODS: ReadonlySet<HttpMethod> = new Set(["GET"]);

/**
 * Reads a cookie the server has set. Used for the CSRF token only: the session
 * cookie is `httpOnly` precisely so that page scripts cannot read it.
 */
export function readCookie(name: string): string | null {
  if (typeof document === "undefined" || typeof document.cookie !== "string") return null;
  const prefix = `${name}=`;
  for (const part of document.cookie.split(";")) {
    const trimmed = part.trim();
    if (!trimmed.startsWith(prefix)) continue;
    const raw = trimmed.slice(prefix.length);
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

/** The current CSRF token, or `null` when the visitor has no session. */
export function readCsrfToken(): string | null {
  return readCookie(CSRF_COOKIE_NAME);
}

function resolveBaseUrl(): string {
  const configured = import.meta.env.VITE_API_BASE_URL;
  if (typeof configured === "string" && configured.trim().length > 0) {
    return configured.trim().replace(/\/+$/, "");
  }
  return DEFAULT_BASE_URL;
}

function isSuccessEnvelope(value: unknown): value is SuccessEnvelope<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { success?: unknown }).success === true &&
    "data" in value
  );
}

function isErrorEnvelope(value: unknown): value is ErrorEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const { success, error } = value as { success?: unknown; error?: unknown };
  if (success !== false || typeof error !== "object" || error === null) return false;
  return typeof (error as { code?: unknown }).code === "string";
}

/**
 * The only place in the client that performs HTTP. Everything above it works
 * with unwrapped data, so no component ever has to think about the envelope.
 */
export class ApiClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string = resolveBaseUrl()) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  /** Absolute or root-relative URL for a path, with query parameters applied. */
  buildUrl(path: string, query?: QueryParams): string {
    const suffix = path.startsWith("/") ? path : `/${path}`;
    const search = buildQuery(query);
    if (search.length === 0) return `${this.baseUrl}${suffix}`;
    const separator = suffix.includes("?") ? "&" : "?";
    return `${this.baseUrl}${suffix}${separator}${search}`;
  }

  /**
   * Answers one call from the placeholder dataset.
   *
   * The delay is deliberate and short: an instant answer would make a screen look
   * loaded before it had finished rendering, which is the sort of thing that hides
   * a loading state that is broken.
   *
   * A path with no handler is reported as a real failure rather than as empty
   * data, because a demonstration that quietly shows a blank screen where the
   * product would have shown an error is worse than one that fails.
   */
  private async fromDemoData<T>(
    method: HttpMethod,
    path: string,
    body: unknown,
    query: QueryParams | undefined,
    signal: AbortSignal | undefined
  ): Promise<T> {
    if (signal?.aborted) {
      throw new DOMException("The request was cancelled.", "AbortError");
    }
    await new Promise((resolve) => setTimeout(resolve, 60));
    if (signal?.aborted) {
      throw new DOMException("The request was cancelled.", "AbortError");
    }

    const plainQuery: Record<string, string | number | boolean | undefined> = {};
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== null && value !== undefined) plainQuery[key] = value;
    }

    try {
      return demoRequest({ method, path, body, query: plainQuery }) as T;
    } catch (error) {
      if (error instanceof DemoRouteNotFound) {
        // Surfaced as an API error so the screen's own error handling runs, which
        // is what a participant would see against the real service.
        throw new ApiError({
          code: "NOT_FOUND",
          message: `Demo data has nothing for ${method} ${path}. Add a handler so this screen can be reviewed.`,
          status: 501,
          requestId: "demo",
        });
      }
      throw error;
    }
  }

  async request<T>(method: HttpMethod, path: string, options: RequestOptions = {}): Promise<T> {
    const { body, formData, query, signal, idempotencyKey } = options;

    // Demo data answers here, before anything touches the network, so every screen
    // is reachable without a database, a chain or a wallet. It is off by default
    // and cannot be on in a production build without an explicit acknowledgement.
    if (isDemoDataEnabled()) {
      return (await this.fromDemoData<T>(method, path, body, query, signal)) as T;
    }

    if (body !== undefined && formData !== undefined) {
      throw new Error(
        "ApiClient.request accepts either a JSON body or a FormData body, not both.",
      );
    }

    const headers = new Headers();
    headers.set("Accept", "application/json");

    let requestBody: BodyInit | undefined;
    if (formData !== undefined) {
      requestBody = formData;
    } else if (body !== undefined) {
      headers.set("Content-Type", "application/json");
      requestBody = JSON.stringify(body);
    }

    if (!SAFE_METHODS.has(method)) {
      const csrf = readCsrfToken();
      if (csrf !== null && csrf.length > 0) headers.set(CSRF_HEADER_NAME, csrf);
    }
    if (idempotencyKey !== undefined) headers.set("Idempotency-Key", idempotencyKey);

    const response = await this.send(path, {
      method,
      headers,
      signal,
      query,
      ...(requestBody === undefined ? {} : { body: requestBody }),
    });

    if (!response.ok) throw await this.toError(response);

    return (await readEnvelope<T>(response)) as T;
  }

  /**
   * Fetches a binary endpoint. This deliberately bypasses the JSON envelope:
   * media and exports are raw bytes, and a parse attempt would corrupt them.
   */
  async download(path: string, options: DownloadOptions = {}): Promise<Blob> {
    const { method = "GET", query, signal } = options;
    const headers = new Headers();
    if (!SAFE_METHODS.has(method)) {
      const csrf = readCsrfToken();
      if (csrf !== null && csrf.length > 0) headers.set(CSRF_HEADER_NAME, csrf);
    }

    const response = await this.send(path, { method, headers, signal, query });
    if (!response.ok) throw await this.toError(response);
    return await response.blob();
  }

  private async send(
    path: string,
    init: {
      method: HttpMethod;
      headers: Headers;
      signal?: AbortSignal | undefined;
      query?: QueryParams | undefined;
      body?: BodyInit | undefined;
    },
  ): Promise<Response> {
    const { method, headers, signal, query, body } = init;
    try {
      return await fetch(this.buildUrl(path, query), {
        method,
        headers,
        // The session and CSRF cookies are first-party; they must travel.
        credentials: "include",
        ...(signal === undefined ? {} : { signal }),
        ...(body === undefined ? {} : { body }),
      });
    } catch (cause) {
      // An abort is the caller's own decision, so it is passed through
      // untouched rather than dressed up as a network failure.
      if (cause instanceof Error && cause.name === "AbortError") throw cause;
      throw ApiError.network(
        "The application could not reach the server. Check your connection and try again.",
        cause,
      );
    }
  }

  private async toError(response: Response): Promise<ApiError> {
    const body = await readJsonBody(response);
    if (isErrorEnvelope(body)) {
      const { code, message, details, requestId } = body.error;
      return new ApiError({
        code: toApiErrorCode(code),
        status: response.status,
        message: typeof message === "string" && message.length > 0 ? message : undefined,
        ...(details === undefined ? {} : { details }),
        ...(typeof requestId === "string" ? { requestId } : {}),
      });
    }
    return new ApiError({
      code: response.status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR",
      status: response.status,
      message: `The server returned an unexpected response (HTTP ${response.status}).`,
    });
  }
}

function buildQuery(query: QueryParams | undefined): string {
  if (query === undefined) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    const text = typeof value === "string" ? value : String(value);
    if (text.length === 0) continue;
    params.append(key, text);
  }
  return params.toString();
}

async function readJsonBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.trim().length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** Unwraps a success envelope, tolerating 204s and empty bodies. */
async function readEnvelope<T>(response: Response): Promise<T | undefined> {
  if (response.status === 204) return undefined;
  const text = await response.text();
  if (text.trim().length === 0) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (cause) {
    throw new ApiError({
      code: "INTERNAL_ERROR",
      status: response.status,
      message: "The server sent a response this application could not read.",
      cause,
    });
  }

  if (isErrorEnvelope(parsed)) {
    const { code, message, details, requestId } = parsed.error;
    throw new ApiError({
      code: toApiErrorCode(code),
      status: response.status,
      message: typeof message === "string" && message.length > 0 ? message : undefined,
      ...(details === undefined ? {} : { details }),
      ...(typeof requestId === "string" ? { requestId } : {}),
    });
  }

  if (isSuccessEnvelope(parsed)) return parsed.data as T;

  // A response that is not an envelope at all is still handed back, so a plain
  // payload from a future endpoint is not silently dropped.
  return parsed as T;
}

/** The shared client. One instance, so one place to change the base URL. */
export const api = new ApiClient();
