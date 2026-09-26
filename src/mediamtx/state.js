import * as mtx from './client.js';

/**
 * Tracks MediaMTX between polls, for the MediaMTX panel, the LiveU
 * destination dropdown and the studio log:
 *
 *  - the site's stream list (every configured stream, live or not) + SRT address;
 *  - the site's events feed: each stream's latest camera → server (IN) and
 *    server → studio (OUT) status, and low-bitrate warnings;
 *  - optionally MediaMTX's own API, which is used for IN/OUT when set (it
 *    sees every publisher and every reader, not just the studio) and gives
 *    bitrate from the bytes counted between polls.
 *
 * The events API returns a rolling window, so events are de-duplicated by
 * timestamp + path + hop. The first poll only records what's there, so a
 * restart doesn't re-log history.
 */

export const HOP_LABELS = { 'camera-server': 'Cam → server', 'server-studio': 'Server → studio' };
const HOPS = Object.keys(HOP_LABELS);
// Streams with no live feed and no event this recent drop off the board.
const SHOW_RECENT_MS = 24 * 60 * 60 * 1000;
const SEEN_MAX = 5000;

let seen = new Set();
let firstEventsPoll = true;
// `${path}::${hop}` -> { connectivity: event, warning: event }
const latest = new Map();
let current = { configured: false, streams: [], srtAddress: null, paths: [], error: null };
// From MediaMTX's own API: path -> { ready, readers, inKbps, outKbps }; null when not configured or it failed.
let api = null;
// path -> { rx, tx, at } byte counters from the previous API poll, for bitrate.
let lastBytes = new Map();

const eventKey = (ev) => `${ev.timestamp}::${ev.path}::${ev.hop}`;

export function mediamtxState() {
  return current;
}

function applyEvent(ev) {
  const key = `${ev.path}::${ev.hop}`;
  const entry = latest.get(key) ?? {};
  const slot = ev.status === 'online' || ev.status === 'offline' ? 'connectivity' : 'warning';
  if (!entry[slot] || ev.timestamp >= entry[slot].timestamp) entry[slot] = ev;
  latest.set(key, entry);
}

/** 'online' | 'warning' | 'offline' | null for one stream's hop — a warning only counts if it's newer than the last connect. */
function hopStatus(path, hop) {
  const entry = latest.get(`${path}::${hop}`);
  if (!entry?.connectivity) return null;
  if (entry.connectivity.status !== 'online') return { status: 'offline', at: entry.connectivity.timestamp };
  const w = entry.warning;
  if (w?.status === 'warning' && w.timestamp >= entry.connectivity.timestamp) {
    return { status: 'warning', bitrateMbps: typeof w.bitrateMbps === 'number' ? w.bitrateMbps : null, at: w.timestamp };
  }
  return { status: 'online', at: Math.max(entry.connectivity.timestamp, w?.timestamp ?? 0) };
}

/** Kbps from two byte counters `ms` apart; null on the first sample or a counter reset. */
function kbps(bytes, prevBytes, ms) {
  if (typeof bytes !== 'number' || typeof prevBytes !== 'number' || ms <= 0 || bytes < prevBytes) return null;
  return ((bytes - prevBytes) * 8) / ms; // bits per ms = kbps
}

async function pollApi() {
  const now = Date.now();
  const items = await mtx.getApiPaths();
  const next = new Map();
  const bytes = new Map();
  for (const item of items) {
    if (!item?.name) continue;
    const prev = lastBytes.get(item.name);
    bytes.set(item.name, { rx: item.bytesReceived, tx: item.bytesSent, at: now });
    next.set(item.name, {
      ready: Boolean(item.ready),
      readers: Array.isArray(item.readers) ? item.readers.length : 0,
      inKbps: prev ? kbps(item.bytesReceived, prev.rx, now - prev.at) : null,
      outKbps: prev ? kbps(item.bytesSent, prev.tx, now - prev.at) : null,
    });
  }
  lastBytes = bytes;
  api = next;
}

const isUp = (hop) => hop?.status === 'online' || hop?.status === 'warning';

/**
 * One entry per stream: `in` (something publishing), `out` (something
 * pulling), `readers` (count, API only), `inKbps` / `outKbps` (API only),
 * and the per-hop event status (for low-bitrate notes). IN/OUT come from
 * MediaMTX's API when it's configured, else from the site's events; null
 * means unknown (neither source says).
 */
function buildPaths(streams) {
  const names = new Set(streams);
  if (api) for (const name of api.keys()) names.add(name);
  const now = Date.now();
  for (const [key, entry] of latest) {
    const recent = Math.max(entry.connectivity?.timestamp ?? 0, entry.warning?.timestamp ?? 0);
    if (now - recent < SHOW_RECENT_MS) names.add(key.split('::')[0]);
  }
  return [...names]
    .sort((a, b) => a.localeCompare(b))
    .map((path) => {
      const hops = Object.fromEntries(HOPS.map((hop) => [hop, hopStatus(path, hop)]));
      const a = api?.get(path);
      // No event for a hop means it's never connected; null only when there's no events feed to ask.
      const fromEvents = (hop) => (mtx.eventsConfigured() ? isUp(hops[hop]) : null);
      return {
        path,
        in: a ? a.ready : api ? false : fromEvents('camera-server'),
        out: a ? a.readers > 0 : api ? false : fromEvents('server-studio'),
        readers: a ? a.readers : null,
        inKbps: a?.inKbps ?? null,
        outKbps: a?.outKbps ?? null,
        hops,
      };
    });
}

/**
 * One poll of the site. Returns the events that are new since the last
 * poll (empty on the first), for the studio log. Never throws — an error
 * is kept on the state and shown on the board.
 */
export async function pollMediamtx() {
  if (!mtx.isConfigured() && !mtx.eventsConfigured() && !mtx.apiConfigured()) {
    current = { configured: false, streams: [], srtAddress: null, paths: [], error: null };
    return [];
  }

  const errors = [];
  let { streams, srtAddress } = current;
  if (mtx.isConfigured()) {
    try {
      ({ streams, srtAddress } = await mtx.getStreams());
    } catch (err) {
      errors.push(err.message);
    }
  }

  if (mtx.apiConfigured()) {
    try {
      await pollApi();
    } catch (err) {
      api = null; // fall back to the site's events for IN/OUT
      errors.push(err.message);
    }
  }

  const fresh = [];
  if (mtx.eventsConfigured()) {
    try {
      // Timestamps are ms numbers per the Studio Patch app; accept ISO strings too.
      const events = (await mtx.getEvents())
        .map((ev) => ({ ...ev, timestamp: typeof ev?.timestamp === 'number' ? ev.timestamp : Date.parse(ev?.timestamp) }))
        .filter((ev) => ev.path && ev.hop && Number.isFinite(ev.timestamp));
      events.sort((a, b) => a.timestamp - b.timestamp);
      for (const ev of events) {
        const key = eventKey(ev);
        if (seen.has(key)) continue;
        seen.add(key);
        applyEvent(ev);
        if (!firstEventsPoll) fresh.push(ev);
      }
      if (seen.size > SEEN_MAX) seen = new Set([...seen].slice(-SEEN_MAX / 2));
      firstEventsPoll = false;
    } catch (err) {
      errors.push(err.message);
    }
  }

  current = { configured: true, streams, srtAddress, paths: buildPaths(streams), error: errors.join(' · ') || null };
  return fresh;
}

/** A studio-log line for one media-mtx event. */
export function describeEvent(ev) {
  const where = `**${ev.path}** (${HOP_LABELS[ev.hop] ?? ev.hop})`;
  switch (ev.status) {
    case 'online':
      return `📡 ${where} online`;
    case 'offline':
      return `🔴 ${where} **offline**`;
    case 'warning':
      return `📉 ${where} low bitrate${typeof ev.bitrateMbps === 'number' ? `: **${ev.bitrateMbps.toFixed(2)} Mbps**` : ''}`;
    case 'recovered':
      return `📈 ${where} bitrate recovered`;
    default:
      return `📡 ${where} ${ev.status}`;
  }
}
