import fs from 'node:fs';
import path from 'node:path';

/**
 * Minimal persisted JSON file store — read the whole thing, get back a
 * default if it doesn't exist yet or fails to parse, write it back
 * atomically (write to a .tmp file, then rename over the real path, so a
 * crash mid-write can't leave a corrupt/partial file).
 */
export function readJsonFile(filePath, defaultValue) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`Failed to read ${filePath}, using default:`, err);
    }
    return defaultValue;
  }
}

export function writeJsonFile(filePath, value) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2));
  fs.renameSync(tmpPath, filePath);
}
