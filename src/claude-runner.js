import { spawn } from 'node:child_process';
import { config } from './config.js';

/**
 * Runs `claude` headlessly (print mode) inside `cwd`, letting it edit files
 * on disk. Returns the final result text and the parsed stream-json events
 * so the caller can show progress / a summary.
 *
 * Uses `--permission-mode acceptEdits` so it doesn't block waiting for
 * interactive approval, and restricts tools to what's needed for code edits
 * (no arbitrary bash by default — widen ALLOWED_TOOLS if you want that).
 */
export function runClaudeCode({ cwd, prompt, onEvent }) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      CLAUDE_CONFIG_DIR: config.claude.configDir,
    };
    if (config.claude.apiKey) {
      env.ANTHROPIC_API_KEY = config.claude.apiKey;
    }

    const args = [
      '-p', prompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', 'acceptEdits',
      '--allowedTools', 'Read,Edit,Write,Glob,Grep',
    ];

    const child = spawn('claude', args, { cwd, env });

    let buffer = '';
    let lastResult = null;
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      let idx;
      // stream-json emits one JSON object per line
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === 'result') lastResult = event;
          onEvent?.(event);
        } catch {
          // non-JSON stray output, ignore
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);

    child.on('close', (code) => {
      if (code !== 0 && !lastResult) {
        reject(new Error(`claude exited with code ${code}: ${stderr.slice(-2000)}`));
        return;
      }
      resolve({ result: lastResult, stderr, exitCode: code });
    });
  });
}
