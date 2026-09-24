import { prepareRepo, commitAndPush } from './repo.js';
import { runClaudeCode } from './claude-runner.js';
import { openPullRequest, parseRepoSlug } from './github.js';

/**
 * End-to-end: clone/checkout branch -> run Claude Code -> commit/push -> open PR.
 * `onProgress(text)` is called with human-readable status updates so the
 * caller can edit a Discord message as things happen.
 */
export async function runCodeJob({ repoSlug, prompt, base, onProgress }) {
  const { owner, name } = parseRepoSlug(repoSlug);
  const branchSuffix = new Date().toISOString().replace(/[:.]/g, '-');

  onProgress(`📥 Cloning/updating \`${repoSlug}\`...`);
  const { git, dir, defaultBranch, branchName } = await prepareRepo({
    owner,
    name,
    base,
    branchSuffix,
  });

  onProgress(`🤖 Running Claude Code on \`${repoSlug}\` (branch \`${branchName}\`)...\n> ${prompt}`);

  let toolCallCount = 0;
  const { result } = await runClaudeCode({
    cwd: dir,
    prompt,
    onEvent: (event) => {
      if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
        for (const block of event.message.content) {
          if (block.type === 'tool_use') {
            toolCallCount += 1;
            if (toolCallCount % 3 === 0) {
              onProgress(`🔧 Working... (${toolCallCount} tool calls so far)`);
            }
          }
        }
      }
    },
  });

  if (!result) {
    throw new Error('Claude Code did not return a result (check container logs)');
  }
  if (result.subtype && result.subtype !== 'success') {
    throw new Error(`Claude Code finished with subtype "${result.subtype}": ${result.result ?? ''}`);
  }

  onProgress('📦 Committing and pushing changes...');
  const commitMessage = `Claude Code: ${prompt.slice(0, 72)}`;
  const { pushed } = await commitAndPush(git, branchName, commitMessage);

  if (!pushed) {
    return {
      pushed: false,
      summary: result.result,
      branchName,
      defaultBranch,
    };
  }

  onProgress('🔀 Opening pull request...');
  const pr = await openPullRequest({
    owner,
    repo: name,
    base: defaultBranch,
    head: branchName,
    title: commitMessage,
    body: `Automated change requested via Discord:\n\n> ${prompt}\n\n---\n${result.result ?? ''}`.slice(0, 60000),
  });

  return {
    pushed: true,
    pr,
    summary: result.result,
    branchName,
    defaultBranch,
  };
}
