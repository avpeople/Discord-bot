const PREVIEW_VALUE_CHARS = 300;

const truncate = (s, max) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const quote = (s) => truncate(s, PREVIEW_VALUE_CHARS).replace(/\n/g, ' ');

/**
 * Checks one text value the way the site will (see cleanText in the site's
 * server/content.js). `spec` is a text field or a list item's text part.
 * Returns `{ value }`, or `{ problem }` with the reason as a phrase.
 */
function checkText(spec, raw) {
  if (typeof raw !== 'string') return { problem: 'has to be text' };
  const value = raw.replace(/\r\n?/g, '\n').trim();
  if (!spec.multiline && value.includes('\n')) return { problem: 'has to be a single line' };
  if (value.length > spec.maxLength) return { problem: `is too long (limit ${spec.maxLength} characters)` };
  if (spec.required && !value) return { problem: "can't be empty" };
  return { value };
}

/** A short name for a list item in previews: its first non-empty text part (the name, quote, question or caption). */
function itemTitle(field, item) {
  const part = field.itemParts.find((p) => p.type === 'text' && item[p.name]);
  return part ? truncate(item[part.name].replace(/\n/g, ' '), 60) : `item ${item.id}`;
}

/**
 * Checks the text and image parts Claude gave for a list item. Returns
 * `{ values, images }` (`images` maps an image part's name to an index
 * into the attached photos), or `{ problem }`.
 */
function checkItemParts(field, rawValues, rawImages, imageCount) {
  const values = {};
  for (const [name, raw] of Object.entries(rawValues ?? {})) {
    const part = field.itemParts.find((p) => p.name === name && p.type === 'text');
    if (!part) return { problem: `has no text part called \`${String(name).slice(0, 40)}\`` };
    const { value, problem } = checkText(part, raw);
    if (problem) return { problem: `: ${part.label} ${problem}` };
    values[name] = value;
  }
  const images = {};
  for (const [name, raw] of Object.entries(rawImages ?? {})) {
    const part = field.itemParts.find((p) => p.name === name && p.type === 'image');
    const index = Number(raw) - 1;
    if (!part) return { problem: `has no photo part called \`${String(name).slice(0, 40)}\`` };
    if (!Number.isInteger(index) || index < 0 || index >= imageCount) return { problem: `: no attached photo to use for ${part.label}` };
    images[name] = index;
  }
  return { values, images };
}

function checkPosition(raw) {
  return raw === undefined || (Number.isInteger(raw) && raw >= 1);
}

/** One list operation (add / change / remove an item). Returns `{ edit }`, `{ problem }` or `{}` if it changes nothing. */
function validateListEdit(raw, field, imageCount, added) {
  const label = `**${field.label}**`;
  if (!checkPosition(raw.position)) return { problem: `${label}: the position has to be a whole number, 1 for first.` };

  if (raw.add !== undefined) {
    if (field.value.length + added >= field.maxItems) return { problem: `${label} is full (limit ${field.maxItems} items).` };
    const checked = checkItemParts(field, raw.add, raw.images, imageCount);
    if (checked.problem) return { problem: `New item for ${label} ${checked.problem}.` };
    for (const part of field.itemParts) {
      if (part.type === 'image' && checked.images[part.name] === undefined) {
        return { problem: `A new item for ${label} needs a photo — attach one and ask again.` };
      }
      if (part.type === 'text' && part.required && !checked.values[part.name]) {
        return { problem: `A new item for ${label} needs: ${part.label}.` };
      }
    }
    return { edit: { field, kind: 'add', values: checked.values, images: checked.images, position: raw.position } };
  }

  const index = field.value.findIndex((item) => item.id === String(raw.item));
  if (index < 0) return { problem: `Couldn't find that item in ${label}.` };
  const item = field.value[index];
  if (raw.remove === true) return { edit: { field, kind: 'remove', item, index } };

  const checked = checkItemParts(field, raw.set, raw.images, imageCount);
  if (checked.problem) return { problem: `"${itemTitle(field, item)}" in ${label} ${checked.problem}.` };
  const values = Object.fromEntries(Object.entries(checked.values).filter(([name, value]) => value !== item[name]));
  const position = raw.position === index + 1 ? undefined : raw.position;
  if (Object.keys(values).length + Object.keys(checked.images).length === 0 && position === undefined) return {};
  return { edit: { field, kind: 'update', item, index, values, images: checked.images, position } };
}

/**
 * Checks Claude's raw proposal against the site's field list, so nothing
 * the site would refuse (or that changes nothing) reaches the preview.
 * Returns `{ edits, problems }`. Each edit has `field` (the site's current
 * description of it) and `kind`:
 * - 'text' `{ value }`, 'image' `{ imageIndex }`, 'reset' — a whole field
 * - 'add' `{ values, images, position? }` — a new list item
 * - 'update' `{ item, index, values, images, position? }` — a list item
 * - 'remove' `{ item, index }` — a list item
 * `problems` are sentences for the person about any that were dropped.
 */
export function validateEdits(rawEdits, fields, imageCount) {
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const edits = [];
  const problems = [];
  const seen = new Set();
  const addedTo = new Map(); // list key -> items this proposal adds, for the size limit

  for (const raw of rawEdits) {
    const field = byKey.get(raw?.key);
    if (!field) {
      problems.push(`\`${String(raw?.key).slice(0, 80)}\` isn't an editable field.`);
      continue;
    }
    const isItemEdit = raw.add !== undefined || raw.item !== undefined;
    // One change per field or list item; several new items in a list are fine.
    const target = raw.item !== undefined ? `${field.key}/${raw.item}` : field.key;
    if (raw.add === undefined) {
      if (seen.has(target)) continue;
      seen.add(target);
    }

    if (field.type === 'list' && isItemEdit) {
      const { edit, problem } = validateListEdit(raw, field, imageCount, addedTo.get(field.key) ?? 0);
      if (problem) problems.push(problem);
      if (edit?.kind === 'add') addedTo.set(field.key, (addedTo.get(field.key) ?? 0) + 1);
      if (edit) edits.push(edit);
    } else if (isItemEdit) {
      problems.push(`**${field.label}** isn't a list, so items can't be added or removed.`);
    } else if (raw.reset === true) {
      if (field.edited) edits.push({ field, kind: 'reset' });
      else problems.push(`**${field.label}** is already the original.`);
    } else if (field.type === 'list') {
      problems.push(`**${field.label}** is a list — its items are changed one at a time.`);
    } else if (raw.image !== undefined) {
      const index = Number(raw.image) - 1;
      if (field.type !== 'image') problems.push(`**${field.label}** is text, so it can't take a photo.`);
      else if (!Number.isInteger(index) || index < 0 || index >= imageCount) problems.push(`No attached photo to use for **${field.label}**.`);
      else edits.push({ field, kind: 'image', imageIndex: index });
    } else if (field.type !== 'text') {
      problems.push(`**${field.label}** is a photo, so it can't take text.`);
    } else {
      const { value, problem } = checkText(field, raw.value);
      if (problem) problems.push(`The new text for **${field.label}** ${problem}.`);
      else if (value !== field.value) edits.push({ field, kind: 'text', value });
    }
  }
  return { edits, problems };
}

/** Changed lines of a one-item-per-line value as a ```diff block (removed lines red, added green). */
function lineDiff(before, after) {
  const oldLines = before.split('\n');
  const newLines = after.split('\n');
  const removed = oldLines.filter((l) => !newLines.includes(l)).map((l) => `- ${l}`);
  const added = newLines.filter((l) => !oldLines.includes(l)).map((l) => `+ ${l}`);
  // Only the order changed: show the whole new value.
  const lines = removed.length + added.length > 0 ? [...removed, ...added] : newLines.map((l) => `+ ${l}`);
  return `\`\`\`diff\n${truncate(lines.join('\n'), PREVIEW_VALUE_CHARS * 2)}\n\`\`\``;
}

const beforeAfter = (before, after) => `> ~~${quote(before)}~~\n> ${quote(after)}`;

/** The lines describing a list item's new parts: text values, photo and position. */
function itemPartLines(edit, imageNames, before) {
  const { field } = edit;
  const lines = [];
  for (const part of field.itemParts) {
    if (part.type === 'image' && edit.images[part.name] !== undefined) {
      lines.push(`-# ${part.label}: new photo ${imageNames[edit.images[part.name]]}`);
    } else if (part.type === 'text' && edit.values[part.name] !== undefined && (before || edit.values[part.name])) {
      lines.push(
        before?.[part.name]
          ? `-# ${part.label}:\n${beforeAfter(before[part.name], edit.values[part.name] || '(empty)')}`
          : `-# ${part.label}: ${quote(edit.values[part.name])}`,
      );
    }
  }
  if (edit.position !== undefined) lines.push(`-# ${before ? 'moved to' : 'placed at'} position ${edit.position}`);
  return lines.join('\n');
}

/** The before/after shown to the person for one edit, ahead of Apply. */
export function describeEdit(edit, imageNames) {
  const { field } = edit;
  switch (edit.kind) {
    case 'reset': {
      const what = { image: 'photo', list: 'list — every change to it is discarded' }[field.type] ?? 'text';
      return `↩️ **${field.label}**\n-# back to the site's original ${what}`;
    }
    case 'image':
      return `🖼️ **${field.label}**\n-# new photo: ${imageNames[edit.imageIndex]}`;
    case 'add':
      return `➕ **${field.label}** — new item\n${itemPartLines(edit, imageNames, null)}`;
    case 'update':
      return `✏️ **${field.label}** — ${itemTitle(field, edit.item)}\n${itemPartLines(edit, imageNames, edit.item)}`;
    case 'remove':
      return `🗑️ **${field.label}** — remove "${itemTitle(field, edit.item)}"`;
    default:
      return field.multiline
        ? `✏️ **${field.label}**\n${lineDiff(field.value, edit.value)}`
        : `✏️ **${field.label}**\n${beforeAfter(field.value, edit.value)}`;
  }
}
