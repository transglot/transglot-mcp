import { expect, test } from 'vitest';

import { DEFAULT_APP_URL, DEFAULT_BASE_URL, loadConfig } from '../src/config.js';

test('requires TRANSGLOT_TOKEN', () => {
  expect(() => loadConfig({})).toThrow(/TRANSGLOT_TOKEN/);
});

test('defaults the base url to the hosted service', () => {
  const config = loadConfig({ TRANSGLOT_TOKEN: 'tgl_x' });

  expect(config).toEqual({ token: 'tgl_x', baseUrl: DEFAULT_BASE_URL });
  // The MACHINE host. The web UI lives on app.transglot.ai and 404s /v1/*, and the api
  // host 404s every browser page — defaulting to the wrong one breaks every call.
  expect(DEFAULT_BASE_URL).toBe('https://api.transglot.ai');
  expect(DEFAULT_APP_URL).toBe('https://app.transglot.ai');
});

test('TRANSGLOT_BASE_URL overrides, with trailing slashes trimmed', () => {
  const config = loadConfig({ TRANSGLOT_TOKEN: 'tgl_x', TRANSGLOT_BASE_URL: 'https://loc.example.com/' });

  expect(config.baseUrl).toBe('https://loc.example.com');
});

test('falls back to TRANSGLOT_URL (the CLI env) when BASE_URL is unset', () => {
  const config = loadConfig({ TRANSGLOT_TOKEN: 'tgl_x', TRANSGLOT_URL: 'https://cli.example.com' });

  expect(config.baseUrl).toBe('https://cli.example.com');
});

test('plain http is allowed only for loopback hosts', () => {
  expect(loadConfig({ TRANSGLOT_TOKEN: 't', TRANSGLOT_BASE_URL: 'http://localhost:8971' }).baseUrl)
    .toBe('http://localhost:8971');
  expect(() => loadConfig({ TRANSGLOT_TOKEN: 't', TRANSGLOT_BASE_URL: 'http://evil.example.com' }))
    .toThrow(/http\(s\)/);
  expect(() => loadConfig({ TRANSGLOT_TOKEN: 't', TRANSGLOT_BASE_URL: 'file:///etc/passwd' }))
    .toThrow(/http\(s\)/);
});
