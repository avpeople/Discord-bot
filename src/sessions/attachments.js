import fs from 'node:fs';
import path from 'node:path';

const IMAGE_CONTENT_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MAX_IMAGE_BYTES = 15 * 1024 * 1024; // generous; Discord itself caps well below this for most plans
const MAX_FILE_BYTES = 10 * 1024 * 1024; // text/logs/PDFs — bigger than this is rarely worth Claude's tokens

// Non-image files Claude's Read tool handles well: anything text-like, plus
// PDFs. Matched by content type first, then by extension since Discord often
// labels code/log files as application/octet-stream.
const TEXT_CONTENT_TYPE = /^(text\/|application\/(json|xml|javascript|x-yaml|yaml|x-sh|sql|toml|pdf))/;
const TEXT_EXTENSIONS = new Set([
  '.txt', '.log', '.md', '.csv', '.tsv', '.json', '.jsonl', '.xml', '.yml', '.yaml', '.toml', '.ini', '.env',
  '.cfg', '.conf', '.html', '.css', '.scss', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py', '.rb', '.go',
  '.rs', '.java', '.kt', '.cs', '.c', '.h', '.cpp', '.hpp', '.php', '.sh', '.ps1', '.bat', '.sql', '.diff',
  '.patch', '.pdf',
]);

function kindOf(attachment) {
  const type = attachment.contentType?.split(';')[0] ?? '';
  if (IMAGE_CONTENT_TYPES.has(type)) return 'image';
  const ext = path.extname(attachment.name || '').toLowerCase();
  if (TEXT_CONTENT_TYPE.test(type) || TEXT_EXTENSIONS.has(ext)) return 'file';
  return null;
}

/**
 * Downloads image, text, log and PDF attachments on a Discord message into
 * a directory OUTSIDE the session's git working directory (a sibling
 * `<dir>-uploads` folder), so they never get swept into `git add .` and
 * committed into the user's repo. Returns `{ paths, skipped }` — absolute
 * file paths meant to be referenced in the prompt text sent to Claude
 * (verified directly: Claude Code's Read tool can read an image given its
 * file path), and the names of attachments that weren't a supported type
 * or were too big.
 */
export async function downloadAttachments(message, sessionDir) {
  const uploadsDir = `${sessionDir}-uploads`;
  const paths = [];
  const skipped = [];

  let i = 0;
  for (const attachment of message.attachments.values()) {
    const kind = kindOf(attachment);
    const maxBytes = kind === 'image' ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
    if (!kind || attachment.size > maxBytes) {
      skipped.push(attachment.name || 'attachment');
      continue;
    }

    i += 1;
    fs.mkdirSync(uploadsDir, { recursive: true });
    // Keep the original name (sanitized) so Claude sees e.g. "error.log", not just a number.
    const baseName = path.basename(attachment.name || `file-${i}`).replace(/[^\w.-]/g, '_');
    const destPath = path.join(uploadsDir, `${Date.now()}-${i}-${baseName}`);

    const res = await fetch(attachment.url);
    if (!res.ok) {
      console.error(`Failed to download attachment ${attachment.url}: ${res.status}`);
      skipped.push(attachment.name || 'attachment');
      continue;
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(destPath, buffer);
    paths.push(destPath);
  }
  return { paths, skipped };
}

/** Removes a session's uploads directory, if any. Safe to call even if it never existed. */
export async function cleanupUploadsDir(sessionDir) {
  await fs.promises.rm(`${sessionDir}-uploads`, { recursive: true, force: true });
}
