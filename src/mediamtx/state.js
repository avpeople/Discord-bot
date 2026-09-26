import * as mtx from './client.js';

/**
 * Tracks the media-mtx site between polls: the live stream list + SRT
 * address (for the LiveU destination dropdown), and each stream's latest
 * status per hop from the events feed (for the board and the studio log).
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

function buildPaths(streams) {
  const names = new Set(streams);
  const now = Date.now();
  for (const [key, entry] of latest) {
    const recent = Math.max(entry.connectivity?.timestamp ?? 0, entry.warning?.timestamp ?? 0);
    if (now - recent < SHOW_RECENT_MS) names.add(key.split('::')[0]);
  }
  return [...names]
    .sort((a, b) => a.localeCompare(b))
    .map((path) => ({
      path,
      live: streams.includes(path),
      hops: Object.fromEntries(HOPS.map((hop) => [hop, hopStatus(path, hop)])),
    }));
}

/**
 * One poll of the site. Returns the events that are new since the last
 * poll (empty on the first), for the studio log. Never throws — an error
 * is kept on the state and shown on the board.
 */
export async function pollMediamtx() {
  if (!mtx.isConfigured() && !mtx.eventsConfigured()) {
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
