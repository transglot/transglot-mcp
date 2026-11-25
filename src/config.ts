/** Env-only configuration: the server is stateless and holds exactly one project token. */

/**
 * MACHINE surface — the hosted API host, where every `/v1/…` call goes. This server is
 * headless and never opens a browser, so it needs only this one host.
 */
export const DEFAULT_BASE_URL = 'https://api.transglot.ai';

/**
 * HUMAN surface — where a person creates the token this server needs. Distinct from
 * DEFAULT_BASE_URL: the API host serves no browser pages, so pointing someone there to
 * "create a token in the web UI" would land on a 404.
 */
export const DEFAULT_APP_URL = 'https://app.transglot.ai';

export interface Config {
  token: string;
  baseUrl: string;
}

/**
 * TRANSGLOT_TOKEN is required (a project access token — the token IS the
 * project). TRANSGLOT_BASE_URL overrides the hosted default for self-hosted
 * servers; TRANSGLOT_URL (the CLI's env var) is honored as a fallback so one
 * environment can drive both tools.
 */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const token = env.TRANSGLOT_TOKEN;

  if (token === undefined || token === '') {
    throw new Error(
      'TRANSGLOT_TOKEN is required. Create a project access token in the transglot web UI (project settings → access tokens) and set it in the MCP server env.',
    );
  }

  const raw = env.TRANSGLOT_BASE_URL ?? env.TRANSGLOT_URL ?? DEFAULT_BASE_URL;
  const baseUrl = raw.replace(/\/+$/, '');
  assertHttpUrl(baseUrl);

  return { token, baseUrl };
}

/** True for loopback hosts where plain http is allowed for local dev. */
function isLocalHost(hostname: string): boolean {
  // URL wraps IPv6 hosts in brackets; strip them before comparing.
  const host = hostname.replace(/^\[|\]$/g, '');

  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

/**
 * URL scheme allowlist (CLI parity): the url is handed straight to fetch, so it
 * must be http(s). https is always fine; plain http is dev-only and allowed only
 * for loopback hosts. Anything else — file:, ftp:, a bare non-URL — is an error.
 */
function assertHttpUrl(url: string): void {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`TRANSGLOT_BASE_URL must be an http(s) URL; got: ${url}`);
  }

  if (parsed.protocol === 'https:') {
    return;
  }

  if (parsed.protocol === 'http:' && isLocalHost(parsed.hostname)) {
    return;
  }

  throw new Error(`TRANSGLOT_BASE_URL must be an http(s) URL (plain http is loopback-only); got: ${url}`);
}
