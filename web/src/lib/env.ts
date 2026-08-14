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
