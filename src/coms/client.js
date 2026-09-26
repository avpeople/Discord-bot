import { config } from '../config.js';

/**
 * Client for the AVP coms (intercom) server's bridge API — the same API the
 * hardware bridge appliances use. The bot is registered as a bridge in the
 * coms admin console (Bridges tab → new bridge → copy the key once), which
 * gives it a LiveKit token with talk + listen for every coms channel.
 *
 *   GET  /bridge/config     -> { livekitUrl, channels: [{ id, name, shortName }], channelTokens: { [id]: jwt }, bridge }
 *   POST /bridge/telemetry  -> marks the bridge online in the admin console, with what it's doing
 *
 * Coms channel `id` is LiveKit room `channel:<id>`.
 */

const REQUEST_TIMEOUT_MS = 10_000;
const CONFIG_CACHE_MS = 60_000;

let cached = null; // { at, data }

export function isConfigured() {
  return Boolean(config.coms.apiUrl && config.coms.bridgeKey);
}

async function request(method, path, body) {
  const response = await fetch(`${config.coms.apiUrl.replace(/\/+$/, '')}${path}`, {
    method,
    headers: { 'X-Bridge-Key': config.coms.bridgeKey, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`coms ${method} ${path} failed: ${response.status}${text ? ` — ${text.slice(0, 200)}` : ''}`);
  }
  return response.json();
}

/**
 * The bridge config: LiveKit URL, every coms channel, and a token per
 * channel. Cached briefly for autocomplete; `fresh` skips the cache (use it
 * right before connecting, so the token is new).
 */
export async function getConfig({ fresh = false } = {}) {
  if (!fresh && cached && Date.now() - cached.at < CONFIG_CACHE_MS) return cached.data;
  const data = await request('GET', '/bridge/config');
  cached = { at: Date.now(), data };
  return data;
}

/** Tells the coms admin console the bridge is alive and what it's bridging. */
export function sendTelemetry(reportedState) {
  return request('POST', '/bridge/telemetry', {
    channelCount: reportedState.bridges?.length ?? 0,
    matrixState: {},
    reportedState,
  });
}
