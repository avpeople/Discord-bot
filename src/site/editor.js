import { spawn } from 'node:child_process';
import os from 'node:os';
import { config } from '../config.js';

const TIMEOUT_MS = 120_000;

const INSTRUCTIONS = `You help non-technical staff edit the text and photos on the avp.nz website through Discord. The site exposes a fixed list of editable fields. You work out which fields a request means and what their new values should be. You have no tools: the bot applies your proposal, and only after the person confirms a before/after preview it shows them, so there is no need to repeat the new text in your reply, and you should word it as a proposal ("This will change…") rather than as something already done.

The message you receive contains the field list (one JSON object per line: key, a label saying where it appears on the site, and the current value), any recent conversation in this channel, the names of any images attached to the new message, and the new message itself.

Reply with one or two short, plain sentences for the person. If there is something to change, follow them with a fenced block like this:
\`\`\`edits
[{"key": "contact.hours", "value": "the complete new text"}, {"key": "team.3.photo", "image": 1}, {"key": "home.intro.text.1", "reset": true}]
\`\`\`
- "value" sets a text field. Give the complete new value, not just the part that changed. Fields with "list": true hold one item per line (separate with \\n); keep the lines you weren't asked to change. Every other text field is a single line or paragraph with no line breaks. Stay within the field's "max" characters. Values are shown on the site literally, so use plain text with no Markdown or HTML.
- "image" sets a field that has "image": true to the Nth attached image, counting from 1. An image can't go into a text field.
- "reset" puts a field back to the site's original content.

Change only what was asked, and otherwise keep the existing wording, spelling and punctuation style. Some details appear in more than one field (the phone number is in the footer, on the contact page and inside the quote confirmation text, for example). Include every field that has to change for the site to stay consistent, and mention that you did.

If it isn't clear which field is meant (say, "change the heading", or a photo with nothing saying where it goes), ask one short question instead of guessing and leave out the edits block. Team members and gallery photos are fixed numbered slots: a person can be replaced by overwriting every field of their slot, but slots can't be added or removed. If a request needs something that isn't in the field list (layout, colours, links, navigation, adding or removing slots), say it can't be done from this channel and needs a developer to change the site's code.

Discord doesn't render tables, so don't use them.`;

/** One line of the field list Claude sees. Only what it needs to pick a field and write a valid value. */
function describeField(f) {
  return JSON.stringify({
    key: f.key,
    label: f.label,
    ...(f.type === 'image' ? { image: true } : { ...(f.multiline ? { list: true } : {}), max: f.maxLength }),
    value: f.value,
  });
}

function buildPrompt({ fields, history, imageNames, text }) {
  const parts = [`# Editable fields\n${fields.map(describeField).join('\n')}`];
  if (history.length > 0) {
    parts.push(`# Recent conversation\n${history.map((h) => `${h.role === 'user' ? 'Person' : 'You'}: ${h.text}`).join('\n\n')}`);
  }
  parts.push(
    `# Images attached to the new message\n${imageNames.length > 0 ? imageNames.map((n, i) => `${i + 1}. ${n}`).join('\n') : 'None'}`,
    `# New message\n${text || '(no text, only the attached images)'}`,
  );
  return parts.join('\n\n');
}

/** Pulls the trailing ```edits block out of Claude's reply. `edits` is null if there's no valid one. */
function parseEditsBlock(replyText) {
  const match = /```edits\s*\n([\s\S]*?)```/.exec(replyText);
  if (!match) return { text: replyText.trim(), edits: null };
  const text = (replyText.slice(0, match.index) + replyText.slice(match.index + match[0].length)).trim();
  try {
    const edits = JSON.parse(match[1]);
    return { text, edits: Array.isArray(edits) ? edits : null };
  } catch {
    return { text, edits: null };
  }
}

/**
 * Asks Claude which fields a Discord message means and what to set them to.
 * A one-shot `claude -p` with no tools and its own short system prompt (the
 * whole field list goes in on stdin), so each request is a single model
 * call rather than a Claude Code session exploring a repo. Resolves with
 * `{ text, edits, result }` — `edits` is the raw, unvalidated array from the
 * reply (or null), `result` the CLI's result event for token stats.
 */
export async function proposeEdits({ fields, history, imageNames, text }) {
  const env = { ...process.env, CLAUDE_CONFIG_DIR: config.claude.configDir };
  if (config.claude.apiKey) env.ANTHROPIC_API_KEY = config.claude.apiKey;

  const output = await new Promise((resolve, reject) => {
    const child = spawn(
      'claude',
      ['-p', '--system-prompt', INSTRUCTIONS, '--model', config.site.model, '--output-format', 'json', '--max-turns', '1', '--tools', '', '--strict-mcp-config'],
      { cwd: os.tmpdir(), env },
    );
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), TIMEOUT_MS);
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (!stdout.trim()) reject(new Error(`claude exited with code ${code}: ${stderr.slice(-500)}`));
      else resolve(stdout);
    });
    child.stdin.end(buildPrompt({ fields, history, imageNames, text }));
  });

  const result = JSON.parse(output);
  if (result.is_error || (result.subtype && result.subtype !== 'success')) {
    throw new Error(String(result.result ?? result.subtype ?? 'Claude returned an error').slice(0, 500));
  }
  return { ...parseEditsBlock(String(result.result ?? '')), result };
}
