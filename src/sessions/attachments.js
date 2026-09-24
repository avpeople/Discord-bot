import fs from 'node:fs';
import path from 'node:path';

const IMAGE_CONTENT_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MAX_IMAGE_BYTES = 15 * 1024 * 1024; // generous; Discord itself caps well below this for most plans

/**
 * Downloads any image attachments on a Discord message into a directory
 * OUTSIDE the session's git working directory (a sibling `<dir>-uploads`
 * folder), so they never get swept into `git add .` and committed into
 * the user's repo. Returns absolute file paths, meant to be referenced by
 * path in the prompt text sent to Claude (verified directly: Claude Code's
 * Read tool can describe/read an image given its file path).
 */
export async function downloadImageAttachments(message, sessionDir) {
  const images = message.attachments.filter(
    (a) => IMAGE_CONTENT_TYPES.has(a.contentType?.split(';')[0]) && a.size <= MAX_IMAGE_BYTES,
  );
  if (images.size === 0) return [];

  const uploadsDir = `${sessionDir}-uploads`;
  fs.mkdirSync(uploadsDir, { recursive: true });

  const paths = [];
  let i = 0;
  for (const attachment of images.values()) {
    i += 1;
    const ext = path.extname(attachment.name || '') || '.png';
    const safeName = `${Date.now()}-${i}${ext}`;
    const destPath = path.join(uploadsDir, safeName);

    const res = await fetch(attachment.url);
    if (!res.ok) {
      console.error(`Failed to download attachment ${attachment.url}: ${res.status}`);
      continue;
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(destPath, buffer);
    paths.push(destPath);
  }
  return paths;
}

/** Removes a session's uploads directory, if any. Safe to call even if it never existed. */
export async function cleanupUploadsDir(sessionDir) {
  await fs.promises.rm(`${sessionDir}-uploads`, { recursive: true, force: true });
}
