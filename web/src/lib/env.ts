const DEFAULT_API_URL = 'http://localhost:8000';

/** Base URL of the API server, without a trailing slash. */
export const API_URL: string = (import.meta.env?.VITE_API_URL ?? DEFAULT_API_URL).replace(
  /\/+$/,
  '',
);

/** Builds an absolute API URL from a root-relative path. */
export function apiUrl(path: string): string {
  return `${API_URL}${path.startsWith('/') ? path : `/${path}`}`;
}

/**
 * Builds the WebSocket URL for an API path.
 *
 * Derived from `VITE_API_URL` rather than configured separately, so a single
 * env var moves both channels; `https` upgrades to `wss` so a page served over
 * TLS is never blocked for mixed content.
 */
export function wsUrl(path: string): string {
  const absolute = apiUrl(path);
  try {
    const url = new URL(absolute, globalThis.location?.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return url.toString();
  } catch {
    return absolute.replace(/^http/, 'ws');
  }
}
