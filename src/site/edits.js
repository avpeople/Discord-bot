const PREVIEW_VALUE_CHARS = 300;

const truncate = (s, max) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/**
 * Checks Claude's raw proposal against the site's field list, so nothing
 * the site would refuse (or that changes nothing) reaches the preview.
 * Returns `{ edits, problems }`: `edits` are `{ field, kind: 'text' |
 * 'image' | 'reset', value?, imageIndex? }` with `field` the site's current
 * description of it; `problems` are sentences for the person about any
 * that were dropped.
 */
export function validateEdits(rawEdits, fields, imageCount) {
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const edits = [];
  const problems = [];
  const seen = new Set();

  for (const raw of rawEdits) {
    const field = byKey.get(raw?.key);
    if (!field) {
      problems.push(`\`${String(raw?.key).slice(0, 80)}\` isn't an editable field.`);
      continue;
    }
    if (seen.has(field.key)) continue;
    seen.add(field.key);

    if (raw.reset === true) {
      if (field.edited) edits.push({ field, kind: 'reset' });
      else problems.push(`**${field.label}** is already the original.`);
    } else if (raw.image !== undefined) {
      const index = Number(raw.image) - 1;
      if (field.type !== 'image') problems.push(`**${field.label}** is text, so it can't take a photo.`);
      else if (!Number.isInteger(index) || index < 0 || index >= imageCount) problems.push(`No attached photo to use for **${field.label}**.`);
      else edits.push({ field, kind: 'image', imageIndex: index });
    } else if (typeof raw.value === 'string') {
      const value = raw.value.replace(/\r\n?/g, '\n').trim();
      if (field.type !== 'text') problems.push(`**${field.label}** is a photo, so it can't take text.`);
      else if (!field.multiline && value.includes('\n')) problems.push(`**${field.label}** has to be a single line.`);
      else if (value.length > field.maxLength) problems.push(`The new text for **${field.label}** is too long (limit ${field.maxLength} characters).`);
      else if (value !== field.value) edits.push({ field, kind: 'text', value });
    } else {
      problems.push(`Couldn't read the change for **${field.label}**.`);
    }
  }
  return { edits, problems };
}

/** Changed lines of a list field as a ```diff block (removed lines red, added green). */
function listDiff(before, after) {
  const oldLines = before.split('\n');
  const newLines = after.split('\n');
  const removed = oldLines.filter((l) => !newLines.includes(l)).map((l) => `- ${l}`);
  const added = newLines.filter((l) => !oldLines.includes(l)).map((l) => `+ ${l}`);
  // Only the order changed: show the whole new list.
  const lines = removed.length + added.length > 0 ? [...removed, ...added] : newLines.map((l) => `+ ${l}`);
  return `\`\`\`diff\n${truncate(lines.join('\n'), PREVIEW_VALUE_CHARS * 2)}\n\`\`\``;
}

/** The before/after shown to the person for one edit, ahead of Apply. */
export function describeEdit(edit, imageNames) {
  const { field } = edit;
  if (edit.kind === 'reset') return `↩️ **${field.label}**\n-# back to the site's original ${field.type === 'image' ? 'photo' : 'text'}`;
  if (edit.kind === 'image') return `🖼️ **${field.label}**\n-# new photo: ${imageNames[edit.imageIndex]}`;
  if (field.multiline) return `✏️ **${field.label}**\n${listDiff(field.value, edit.value)}`;
  const quote = (s) => truncate(s, PREVIEW_VALUE_CHARS).replace(/\n/g, ' ');
  return `✏️ **${field.label}**\n> ~~${quote(field.value)}~~\n> ${quote(edit.value)}`;
}
