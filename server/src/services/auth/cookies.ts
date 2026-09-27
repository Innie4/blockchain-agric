import { env } from "../../config/env.js";

/** Must match the client's `VITE_SIGNIN_DOMAIN` value. */
export const SIGN_IN_DOMAIN = "agri-trace";

export const SESSION_COOKIE = "agri_session";
export const CSRF_COOKIE = "agri_csrf";
export const CSRF_HEADER = "x-csrf-token";

export interface CookieOptions {
  httpOnly: boolean;
  secure: boolean;
  sameSite: "lax" | "strict" | "none";
  domain?: string;
  path: string;
  maxAge?: number;
}

function base(): Omit<CookieOptions, "httpOnly"> {
  return {
    secure: env.COOKIE_SECURE,
    sameSite: env.COOKIE_SAME_SITE,
    path: "/",
    ...(env.COOKIE_DOMAIN !== undefined && env.COOKIE_DOMAIN.length > 0
      ? { domain: env.COOKIE_DOMAIN }
      : {}),
  };
}

/**
 * The session cookie is `httpOnly` so page scripts cannot read it, which is
 * what makes the double-submit CSRF pair meaningful.
 */
export function sessionCookieOptions(maxAgeSeconds: number): CookieOptions {
  return { ...base(), httpOnly: true, maxAge: maxAgeSeconds };
}

/** Readable by the client so it can echo the value in the CSRF header. */
export function csrfCookieOptions(maxAgeSeconds: number): CookieOptions {
  return { ...base(), httpOnly: false, maxAge: maxAgeSeconds };
}

export function clearCookieOptions(): CookieOptions {
  return { ...base(), httpOnly: true, maxAge: 0 };
}

export function sessionMaxAgeSeconds(): number {
  return env.SESSION_TTL_SECONDS;
}
