import { config } from '../config.js';

/**
 * Client for the AVP media-mtx site (the dashboard in front of MediaMTX,
 * not MediaMTX's own API) — the same endpoints the Rugby GFX site and the
 * Studio Patch app use:
 *
 *   POST /api/auth/login  { username, password } -> session cookie
 *   GET  /api/streams     (cookie) -> { streams: [name], srtAddress, hlsAddress, websiteHlsAddress }
 *   GET  /api/events      (X-API-Key) -> { events: [{ timestamp, path, hop, status, bitrateMbps? }] }
 *
 * `hop` is 'camera-server' or 'server-studio'; `status` is online / offline
 * (connectivity) or warning / recovered (bitrate health while online).
 */

const REQUEST_TIMEOUT_MS = 8000;

let cookie = null;
let loginPromise = null;

const baseUrl = () => config.mediamtx.url.replace(/\/+$/, '');

/** Stream list + SRT address need the site login; events need the events API key. */
export function isConfigured() {
  return Boolean(config.mediamtx.url && config.mediamtx.username && config.mediamtx.password);
}

export function eventsConfigured() {
  return Boolean((config.mediamtx.eventsUrl || config.mediamtx.url) && config.mediamtx.eventsApiKey);
}

async function login() {
  const response = await fetch(`${baseUrl()}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: config.mediamtx.username, password: config.mediamtx.password }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`media-mtx site login failed: ${response.status} ${response.statusText}`);
  const setCookie = response.headers.get('set-cookie');
  if (!setCookie) throw new Error('media-mtx site login returned no session cookie');
  cookie = setCookie.split(';')[0];
}

async function ensureLogin(force = false) {
  if (cookie && !force) return;
  loginPromise ??= login().finally(() => {
    loginPromise = null;
  });
  await loginPromise;
}

/** { streams: string[] (currently live), srtAddress: 'srt://host:port', ... }. Re-logs in once if the session expired. */
export async function getStreams(retried = false) {
  if (!isConfigured()) throw new Error('media-mtx site is not configured (MEDIAMTX_URL / MEDIAMTX_USERNAME / MEDIAMTX_PASSWORD).');
  await ensureLogin();
  const response = await fetch(`${baseUrl()}/api/streams`, {
    headers: { Cookie: cookie },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if ((response.status === 401 || response.status === 403) && !retried) {
    await ensureLogin(true);
    return getStreams(true);
  }
  if (!response.ok) throw new Error(`media-mtx /api/streams failed: ${response.status} ${response.statusText}`);
  const data = await response.json();
  return {
    streams: Array.isArray(data?.streams) ? data.streams.map(String) : [],
    srtAddress: data?.srtAddress ?? null,
  };
}

/** The most recent connectivity/bitrate events (order not guaranteed — sort by timestamp). */
export async function getEvents(limit = 500) {
  const base = (config.mediamtx.eventsUrl || config.mediamtx.url).replace(/\/+$/, '');
  const response = await fetch(`${base}/api/events?limit=${limit}`, {
    headers: { 'X-API-Key': config.mediamtx.eventsApiKey },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`media-mtx /api/events failed: ${response.status} ${response.statusText}`);
  const data = await response.json();
  return Array.isArray(data?.events) ? data.events : [];
}

/** Whether MediaMTX's own API (not the site) is configured — it gives real IN/OUT for every connection, and bytes for bitrate. */
export function apiConfigured() {
  return Boolean(config.mediamtx.apiUrl);
}

/**
 * Every path from MediaMTX's own API (GET /v3/paths/list):
 * [{ name, ready, readers: [{ type, id }], bytesReceived, bytesSent }].
 * `ready` means something is publishing; `readers` is everyone pulling it
 * (the studio, a laptop, a decoder...). Basic auth if MEDIAMTX_API_USER is set.
 */
export async function getApiPaths() {
  const headers = {};
  if (config.mediamtx.apiUser) {
    headers.Authorization = `Basic ${Buffer.from(`${config.mediamtx.apiUser}:${config.mediamtx.apiPassword ?? ''}`).toString('base64')}`;
  }
  const response = await fetch(`${config.mediamtx.apiUrl.replace(/\/+$/, '')}/v3/paths/list?itemsPerPage=1000`, {
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`MediaMTX API /v3/paths/list failed: ${response.status} ${response.statusText}`);
  const data = await response.json();
  return Array.isArray(data?.items) ? data.items : [];
}

/** The SRT streamid a LiveU publishes into `path` with (what the Studio Patch app sets). */
export function publishStreamId(path) {
  return `publish:${path}`;
}
