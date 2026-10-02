import { setText, setImage, resetField, downloadImage, addItem, updateItem, setItemImage, removeItem } from './client.js';

/**
 * Applies validated edits (see edits.js) to the site, and works out how to
 * undo each one. An undo step is `{ kind, key, ... }` for runUndo, or null
 * when the change can't be put back: a replaced or removed photo that
 * couldn't be downloaded first (the site deletes it), or a list reset.
 */

/** The current files of a list item's image parts, by part name. Null if any can't be downloaded. */
async function downloadItemImages(field, item, partNames) {
  const buffers = {};
  for (const name of partNames) {
    if (!item[name]) continue; // no photo yet — nothing to restore
    const buffer = await downloadImage(item[name]).catch(() => null);
    if (!buffer) return null;
    buffers[name] = buffer;
  }
  return buffers;
}

async function uploadItemImages(key, id, buffers) {
  for (const [part, buffer] of Object.entries(buffers)) await setItemImage(key, id, part, buffer);
}

/** Adds an item, then its photos. If a photo fails the half-made item is removed again. */
async function addItemWithImages(key, { values, position }, buffers) {
  const item = await addItem(key, { values, position });
  try {
    await uploadItemImages(key, item.id, buffers);
  } catch (err) {
    await removeItem(key, item.id).catch(() => {});
    throw err;
  }
  return item;
}

/** How to put a text or image field back the way it was when the proposal was made. */
async function fieldUndo(field) {
  if (!field.edited) return { kind: 'reset', key: field.key };
  if (field.type === 'text') return { kind: 'text', key: field.key, value: field.value };
  const buffer = await downloadImage(field.value).catch(() => null);
  return buffer ? { kind: 'image', key: field.key, buffer } : null;
}

/** Applies one edit. `images` are the photos attached to the request. Resolves with its undo step (or null). */
export async function applyEdit(edit, images) {
  const { field } = edit;
  const { key } = field;
  const pick = (indexes) => Object.fromEntries(Object.entries(indexes).map(([part, i]) => [part, images[i].buffer]));

  switch (edit.kind) {
    case 'text': {
      const undo = await fieldUndo(field);
      await setText(key, edit.value);
      return undo;
    }
    case 'image': {
      const undo = await fieldUndo(field);
      await setImage(key, images[edit.imageIndex].buffer);
      return undo;
    }
    case 'reset': {
      const undo = field.type === 'list' ? null : await fieldUndo(field);
      await resetField(key);
      return undo;
    }
    case 'add': {
      const item = await addItemWithImages(key, edit, pick(edit.images));
      return { kind: 'remove', key, id: item.id };
    }
    case 'update': {
      const { item } = edit;
      const oldImages = await downloadItemImages(field, item, Object.keys(edit.images));
      const hasText = Object.keys(edit.values).length > 0;
      if (hasText || edit.position !== undefined) {
        await updateItem(key, item.id, { values: hasText ? edit.values : undefined, position: edit.position });
      }
      await uploadItemImages(key, item.id, pick(edit.images));
      if (!oldImages) return null;
      return {
        kind: 'update',
        key,
        id: item.id,
        values: Object.fromEntries(Object.keys(edit.values).map((name) => [name, item[name]])),
        position: edit.position === undefined ? undefined : edit.index + 1,
        images: oldImages,
      };
    }
    case 'remove': {
      const { item } = edit;
      const imageParts = field.itemParts.filter((p) => p.type === 'image').map((p) => p.name);
      const oldImages = await downloadItemImages(field, item, imageParts);
      await removeItem(key, item.id);
      if (!oldImages) return null;
      const values = Object.fromEntries(field.itemParts.filter((p) => p.type === 'text').map((p) => [p.name, item[p.name]]));
      return { kind: 'add', key, values, position: edit.index + 1, images: oldImages };
    }
    default:
      throw new Error(`Unknown edit kind ${edit.kind}`);
  }
}

export async function runUndo(step) {
  switch (step.kind) {
    case 'text':
      return setText(step.key, step.value);
    case 'image':
      return setImage(step.key, step.buffer);
    case 'reset':
      return resetField(step.key);
    case 'remove':
      return removeItem(step.key, step.id);
    case 'add':
      return addItemWithImages(step.key, step, step.images);
    case 'update':
      if (Object.keys(step.values).length > 0 || step.position !== undefined) {
        await updateItem(step.key, step.id, { values: Object.keys(step.values).length > 0 ? step.values : undefined, position: step.position });
      }
      return uploadItemImages(step.key, step.id, step.images);
    default:
      throw new Error(`Unknown undo step ${step.kind}`);
  }
}
