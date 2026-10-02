import { spawn } from 'node:child_process';
import os from 'node:os';
import { config } from '../config.js';
import { pendingChanges } from '../repo.js';

// Enough for Haiku to see what changed without paying for huge diffs.
const MAX_DIFF_CHARS = 30_000;
const TIMEOUT_MS = 60_000;

const INSTRUCTIONS = `You write GitHub pull request titles and descriptions. The diff to describe is on stdin.
Reply with ONLY a JSON object, no other text: {"title": "...", "body": "..."}
- title: under 70 characters, imperative mood, specific (e.g. "Fix login redirect loop on expired sessions"), no trailing period
- body: 1-4 short Markdown bullet points saying what changed and why, for someone skimming the repo history`;

/**
 * Asks Claude (Haiku — cheap and fast) for a PR title + description from
 * the session's pending diff, so Push Live's PRs read like "Fix login
 * redirect loop" instead of "Claude Code session abc123". Runs as a
 * separate one-shot `claude -p` with no tools, in a temp directory so it
 * doesn't load the repo's CLAUDE.md. Resolves with `{ title, body,
 * costUsd }`, or null if anything goes wrong (no changes, timeout,
 * unparseable reply) — callers fall back to the old generic title.
 */
export async function writePullRequestSummary(session) {
  const { stat, patch } = await pendingChanges(session.git);
  if (!patch.trim()) return null;
  const diff = `${stat}\n\n${patch.length > MAX_DIFF_CHARS ? `${patch.slice(0, MAX_DIFF_CHARS)}\n[diff truncated]` : patch}`;

  const env = { ...process.env, CLAUDE_CONFIG_DIR: config.claude.configDir };
  if (config.claude.apiKey) env.ANTHROPIC_API_KEY = config.claude.apiKey;

  const output = await new Promise((resolve) => {
    const child = spawn(
      'claude',
      ['-p', INSTRUCTIONS, '--model', 'haiku', '--output-format', 'json', '--max-turns', '1', '--disallowedTools', 'Bash,Read,Edit,Write,Glob,Grep,WebSearch,WebFetch,TodoWrite,Agent,Task'],
      { cwd: os.tmpdir(), env },
    );
    let stdout = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), TIMEOUT_MS);
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.on('error', () => resolve(null));
    child.on('close', () => {
      clearTimeout(timer);
      resolve(stdout);
    });
    child.stdin.end(diff);
  });
  if (!output) return null;

  try {
    const result = JSON.parse(output);
    const text = String(result.result ?? '');
    const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    const title = String(json.title ?? '').trim().replace(/\.$/, '').slice(0, 100);
    if (!title) return null;
    return { title, body: String(json.body ?? '').trim(), costUsd: Number(result.total_cost_usd) || 0 };
  } catch {
    return null;
  }
}
