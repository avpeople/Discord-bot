import zlib from 'node:zlib';

/**
 * Custom emojis that join up into a smooth, rounded progress bar for the
 * Claude usage display (see claude-usage.js). Each bar is 10 tiles — a
 * rounded left cap, 8 middles, a rounded right cap — and each tile can be
 * full, half or empty, so the bar moves in 5% steps.
 *
 * The tile images are drawn here in code (tiny PNG encoder, no image
 * library) and uploaded once as application emojis, which belong to the
 * bot itself and work in any server without using a server emoji slot.
 * Bump VERSION after changing the drawing so new images get uploaded.
 */

const VERSION = 1;
const SIZE = 128;
const BAR_TOP = 38;
const BAR_BOTTOM = 90;
const RADIUS = (BAR_BOTTOM - BAR_TOP) / 2;
const CENTER_Y = (BAR_TOP + BAR_BOTTOM) / 2;
const CAP_MARGIN = 6;

const COLORS = {
  green: [35, 165, 90],
  yellow: [240, 178, 50],
  red: [242, 63, 67],
};
const TRACK = [78, 80, 88];

const KINDS = ['left', 'mid', 'right'];
const FILLS = { full: 1, half: 0.5, empty: 0 };

/** name → '<:name:id>' once uploaded; empty until initUsageBarEmojis succeeds. */
const emojiStrings = new Map();

function pieceName(kind, fill, color) {
  return fill === 'empty' ? `ubar${VERSION}_${kind}_empty` : `ubar${VERSION}_${kind}_${fill}_${color}`;
}

function allPieces() {
  const pieces = [];
  for (const kind of KINDS) {
    pieces.push({ kind, fill: 'empty', color: null });
    for (const color of Object.keys(COLORS)) {
      pieces.push({ kind, fill: 'full', color }, { kind, fill: 'half', color });
    }
  }
  return pieces.map((p) => ({ ...p, name: pieceName(p.kind, p.fill, p.color) }));
}

/** Whether (x, y) is inside this tile's slice of the bar — a band, with a rounded end on the caps. */
function insideBar(kind, x, y) {
  if (y < BAR_TOP || y > BAR_BOTTOM) return false;
  const px = kind === 'right' ? SIZE - x : x;
  if (kind === 'mid' || px >= CAP_MARGIN + RADIUS) return true;
  const dx = px - (CAP_MARGIN + RADIUS);
  const dy = y - CENTER_Y;
  return dx * dx + dy * dy <= RADIUS * RADIUS;
}

function drawTile({ kind, fill, color }) {
  const fillTo = FILLS[fill] * SIZE;
  const base = color ? COLORS[color] : TRACK;
  const pixels = Buffer.alloc(SIZE * SIZE * 4);
  const SS = 4; // 4x4 supersampling for smooth rounded edges

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let hits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          if (insideBar(kind, x + (sx + 0.5) / SS, y + (sy + 0.5) / SS)) hits++;
        }
      }
      if (hits === 0) continue;

      const rgb = x + 0.5 < fillTo ? base : TRACK;
      // Slight top-to-bottom highlight so the bar doesn't look flat.
      const t = Math.min(Math.max((y + 0.5 - BAR_TOP) / (BAR_BOTTOM - BAR_TOP), 0), 1);
      const lighten = 0.22 * (1 - t);
      const i = (y * SIZE + x) * 4;
      pixels[i] = Math.round(rgb[0] + (255 - rgb[0]) * lighten);
      pixels[i + 1] = Math.round(rgb[1] + (255 - rgb[1]) * lighten);
      pixels[i + 2] = Math.round(rgb[2] + (255 - rgb[2]) * lighten);
      pixels[i + 3] = Math.round((hits / (SS * SS)) * 255);
    }
  }
  return encodePng(SIZE, SIZE, pixels);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Minimal RGBA PNG encoder. */
function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    rgba.copy(rows, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(rows)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Uploads any missing bar tiles as application emojis (a one-off on the
 * first boot after a VERSION change) and remembers their ids. Fails soft —
 * without them, usageBar() returns null and the plain emoji bar is used.
 */
export async function initUsageBarEmojis(client) {
  try {
    const existing = await client.application.emojis.fetch();
    const found = new Map();
    for (const piece of allPieces()) {
      let emoji = existing.find((e) => e.name === piece.name);
      if (!emoji) {
        emoji = await client.application.emojis.create({ attachment: drawTile(piece), name: piece.name });
      }
      found.set(piece.name, emoji.toString());
    }
    emojiStrings.clear();
    for (const [name, str] of found) emojiStrings.set(name, str);
  } catch (err) {
    console.error('Failed to set up usage bar emojis:', err);
  }
}

const SLOTS = 10;

/** The bar for `percent` (0–100) as a string of custom emojis, or null if they aren't set up. */
export function usageBar(percent, color) {
  if (emojiStrings.size === 0) return null;
  // Half-tile steps (5%). Any usage shows at least a sliver; only 100% is completely full.
  let units = Math.round(percent / 5);
  if (percent > 0) units = Math.max(units, 1);
  if (percent < 100) units = Math.min(units, SLOTS * 2 - 1);

  let bar = '';
  for (let i = 0; i < SLOTS; i++) {
    const kind = i === 0 ? 'left' : i === SLOTS - 1 ? 'right' : 'mid';
    const filled = Math.min(Math.max(units - i * 2, 0), 2);
    const fill = filled === 2 ? 'full' : filled === 1 ? 'half' : 'empty';
    const str = emojiStrings.get(pieceName(kind, fill, color));
    if (!str) return null;
    bar += str;
  }
  return bar;
}

