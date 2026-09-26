/**
 * Turns raw LiveU API responses into one normalised snapshot per unit.
 *
 * The interfaces/video endpoints aren't documented, so every field is read
 * through a list of likely names (`pick`) and anything missing comes out as
 * null — the panel shows "—" and no alert fires, rather than guessing.
 * If something reads wrong, `/studio liveu-raw` dumps the real responses;
 * the fix is adding the right field name to a list here.
 */

/** First non-null value among `keys` on `obj`. */
function pick(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null && obj[key] !== '') return obj[key];
  }
  return null;
}

function num(value) {
  const n = typeof value === 'string' ? Number.parseFloat(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function bool(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const v = value.toLowerCase();
    if (['true', 'yes', 'connected', 'up', 'active', 'on', 'ok'].includes(v)) return true;
    if (['false', 'no', 'disconnected', 'down', 'inactive', 'off', 'none', 'no input'].includes(v)) return false;
  }
  return null;
}

/** Strips the `{ data: ... }` / `{ data: { response: ... } }` wrappers these APIs use. */
function unwrap(raw) {
  let value = raw;
  for (let i = 0; i < 3 && value && typeof value === 'object' && !Array.isArray(value); i++) {
    const inner = value.data ?? value.response ?? value.result;
    if (inner === undefined) break;
    value = inner;
  }
  return value;
}

/** The list of interfaces from whatever shape came back: an array, an array under some key, or an object keyed by name. */
function interfaceList(raw) {
  const value = unwrap(raw);
  if (Array.isArray(value)) return value.map((item, i) => ({ item, key: String(i) }));
  if (!value || typeof value !== 'object') return [];
  for (const key of ['interfaces', 'modems', 'links', 'connections', 'items']) {
    if (Array.isArray(value[key])) return value[key].map((item, i) => ({ item, key: String(i) }));
  }
  return Object.entries(value)
    .filter(([, item]) => item && typeof item === 'object' && !Array.isArray(item))
    .map(([key, item]) => ({ item, key }));
}

/** Bitrate in kbps. Fields named *kbps are taken as-is; bare "bitrate" numbers that look like bps are divided down. */
function kbpsFrom(obj, kbpsKeys, otherKeys) {
  const kbps = num(pick(obj, kbpsKeys));
  if (kbps !== null) return kbps;
  const other = num(pick(obj, otherKeys));
  if (other === null) return null;
  return other > 100_000 ? other / 1000 : other;
}

const SIM_PATTERN = /modem|sim|cell|lte|5g|4g|3g|umts|hspa|nr\b/i;
const WIFI_PATTERN = /wi-?fi|wlan/i;
const ETHERNET_PATTERN = /eth|lan|wired/i;

function interfaceKind(item, name) {
  const hint = `${pick(item, ['technology', 'type', 'interfaceType', 'kind', 'network_type']) ?? ''} ${name}`;
  if (WIFI_PATTERN.test(hint)) return 'wifi';
  if (ETHERNET_PATTERN.test(hint)) return 'ethernet';
  if (SIM_PATTERN.test(hint)) return 'sim';
  return 'other';
}

function parseInterface({ item, key }) {
  const name = String(pick(item, ['name', 'displayName', 'display_name', 'port', 'portName', 'interfaceName', 'id']) ?? key);
  const connected = bool(pick(item, ['connected', 'isConnected', 'is_connected', 'status', 'state', 'linkStatus']));
  const enabled = bool(pick(item, ['enabled', 'isEnabled', 'is_enabled']));
  return {
    name,
    kind: interfaceKind(item, name),
    // Some shapes only say "enabled"; treat an enabled interface with no explicit state as up.
    connected: connected ?? enabled,
    kbps: kbpsFrom(
      item,
      ['uplinkKbps', 'upstreamKbps', 'uplink_kbps', 'txKbps', 'tx_kbps', 'throughputKbps', 'bitrateKbps', 'kbps'],
      ['bitrate', 'tx_bitrate', 'txBitrate', 'uplink', 'throughput', 'bandwidth'],
    ),
    signal: num(pick(item, ['signalQuality', 'signal_quality', 'signal', 'signalStrength', 'signal_strength', 'rssi', 'rsrp'])),
    carrier: pick(item, ['operator', 'carrier', 'provider', 'networkName', 'network_name', 'plmn']),
    technology: pick(item, ['technology', 'network_type', 'networkType', 'rat']),
  };
}

function parseVideo(raw) {
  const video = unwrap(raw);
  if (!video || typeof video !== 'object') return { inputConnected: null, resolution: null, fps: null, kbps: null, uptimeSec: null };

  const width = num(pick(video, ['width', 'inputWidth']));
  const height = num(pick(video, ['height', 'inputHeight']));
  let resolution = pick(video, ['resolution', 'inputResolution', 'input_resolution', 'videoResolution', 'format']);
  if (!resolution && width && height) resolution = `${width}x${height}`;
  if (typeof resolution === 'string' && /no\s*(input|signal|video)|unknown|n\/a/i.test(resolution)) resolution = null;

  let inputConnected = bool(
    pick(video, ['inputConnected', 'input_connected', 'isInputConnected', 'videoInputConnected', 'hasInput', 'has_input', 'signalPresent', 'connected', 'inputStatus', 'input_status']),
  );
  if (inputConnected === null && resolution) inputConnected = true;

  return {
    inputConnected,
    resolution: resolution ? String(resolution) : null,
    fps: num(pick(video, ['frameRate', 'framerate', 'frame_rate', 'fps'])),
    kbps: kbpsFrom(video, ['videoBitrateKbps', 'bitrateKbps', 'kbps'], ['videoBitrate', 'video_bitrate', 'bitrate', 'totalBitrate']),
    uptimeSec: num(pick(video, ['uptime', 'stream_uptime', 'streamUptime', 'streamingTime', 'duration'])),
  };
}

/** 'live' | 'online' | 'offline' from the unit list's status string. */
export function unitState(unit) {
  const s = String(unit?.status ?? '').toLowerCase();
  if (s.includes('stream') || s.includes('live') || s.includes('broadcast')) return 'live';
  if (s === 'online' || s.includes('ready') || s.includes('idle') || s.includes('connected')) return 'online';
  return 'offline';
}

/**
 * One unit's snapshot. `details` is { interfaces, video, destinations } raw
 * responses, or null/undefined for offline units (which aren't queried).
 */
export function buildSnapshot(unit, details) {
  const state = unitState(unit);
  const interfaces = details?.interfaces ? interfaceList(details.interfaces).map(parseInterface) : [];
  const video = parseVideo(details?.video);

  const connectedKbps = interfaces.filter((i) => i.connected !== false && i.kbps !== null).map((i) => i.kbps);
  const totalKbps = connectedKbps.length ? connectedKbps.reduce((a, b) => a + b, 0) : video.kbps;

  const activeDestination = (details?.destinations ?? []).find((d) => d?.is_active);

  return {
    id: String(unit.BOSSID ?? unit.bossId ?? unit.id),
    name: String(unit.name || unit.device_name || unit.SN || unit.BOSSID),
    serial: unit.SN ?? unit.device_name ?? null,
    product: unit.product ?? null,
    swVersion: unit.sw_version ?? null,
    battery: num(pick(unit, ['battery', 'battery_level', 'batteryLevel'])),
    state,
    detailsOk: Boolean(details?.interfaces || details?.video),
    interfaces,
    sims: interfaces.filter((i) => i.kind === 'sim'),
    totalKbps: totalKbps ?? null,
    video,
    activePreset: activeDestination?.title ?? null,
  };
}
