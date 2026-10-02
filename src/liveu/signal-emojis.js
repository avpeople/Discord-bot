import { encodePng } from '../usage-bar-emojis.js';

/**
 * Custom signal-strength emojis for the connection rows on the LiveU
 * board: a phone-style staircase of 5 bars, the first N lit (LiveU reports
 * signal as 0–5), coloured by strength, plus a "down" icon with every bar
 * dimmed red for a disconnected link.
 *
 * Drawn here in code and uploaded once as application emojis, the same way
 * as the usage bar (see usage-bar-emojis.js). Bump VERSION after changing
 * the drawing so new images get uploaded.
 */

const VERSION = 1;
const SIZE = 128;
const BARS = 5;
const BAR_WIDTH = 18;
const GAP = 8;
const LEFT = (SIZE - (BARS * BAR_WIDTH + (BARS - 1) * GAP)) / 2;
const BOTTOM = 112;
const MIN_HEIGHT = 24;
const MAX_HEIGHT = 100;
const CORNER = 4;

const OFF = [78, 80, 88];
const DOWN = [120, 50, 54];
const levelColor = (level) => (level <= 1 ? [242, 63, 67] : level === 2 ? [240, 178, 50] : [35, 165, 90]);

const LEVELS = [0, 1, 2, 3, 4, 5];

/** name → '<:name:id>' once uploaded; empty until initSignalEmojis succeeds. */
const emojiStrings = new Map();

const emojiName = (level) => `lusig${VERSION}_${level === 'down' ? 'down' : level}`;

function barHeight(i) {
  return MIN_HEIGHT + ((MAX_HEIGHT - MIN_HEIGHT) * i) / (BARS - 1);
}

/** Which bar (x, y) falls in, or -1. Bars are rectangles with slightly rounded tops. */
function barAt(x, y) {
  for (let i = 0; i < BARS; i++) {
    const left = LEFT + i * (BAR_WIDTH + GAP);
    const right = left + BAR_WIDTH;
    const top = BOTTOM - barHeight(i);
    if (x < left || x > right || y < top || y > BOTTOM) continue;
    // Round the two top corners.
    const cx = x < left + CORNER ? left + CORNER : x > right - CORNER ? right - CORNER : x;
    const cy = top + CORNER;
    if (y < cy && (x - cx) ** 2 + (y - cy) ** 2 > CORNER ** 2) return -1;
    return i;
  }
  return -1;
}

function drawSignal(level) {
  const pixels = Buffer.alloc(SIZE * SIZE * 4);
  const SS = 4; // 4x4 supersampling for smooth edges
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let hits = 0;
      let bar = -1;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const b = barAt(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
          if (b >= 0) {
            hits++;
            bar = b;
          }
        }
      }
      if (hits === 0) continue;
      const rgb = level === 'down' ? DOWN : bar < level ? levelColor(level) : OFF;
      const i = (y * SIZE + x) * 4;
      pixels[i] = rgb[0];
      pixels[i + 1] = rgb[1];
      pixels[i + 2] = rgb[2];
      pixels[i + 3] = Math.round((hits / (SS * SS)) * 255);
    }
  }
  return encodePng(SIZE, SIZE, pixels);
}

/**
 * Uploads any missing signal emojis as application emojis (a one-off on the
 * first boot after a VERSION change) and remembers their ids. Fails soft —
 * without them, signalEmoji() returns null and the board shows plain text.
 */
export async function initSignalEmojis(client) {
  try {
    const existing = await client.application.emojis.fetch();
    const found = new Map();
    for (const level of [...LEVELS, 'down']) {
      const name = emojiName(level);
      let emoji = existing.find((e) => e.name === name);
      if (!emoji) emoji = await client.application.emojis.create({ attachment: drawSignal(level), name });
      found.set(name, emoji.toString());
    }
    emojiStrings.clear();
    for (const [name, str] of found) emojiStrings.set(name, str);
  } catch (err) {
    console.error('Failed to set up LiveU signal emojis:', err);
  }
}

/** The emoji for a 0–5 signal level, or 'down'; null if the emojis aren't set up. */
export function signalEmoji(level) {
  const key = level === 'down' ? 'down' : Math.max(0, Math.min(5, Math.round(level ?? 0)));
  return emojiStrings.get(emojiName(key)) ?? null;
}

