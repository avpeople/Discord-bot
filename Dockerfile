FROM node:20-slim

# git is needed for repo operations; ca-certificates for HTTPS clone. The
# rest are common tools Claude may reach for via Bash (Python, build tools,
# archives, JSON, process inspection).
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      git ca-certificates curl \
      python3 python3-pip python3-venv python-is-python3 \
      build-essential jq zip unzip procps && \
    rm -rf /var/lib/apt/lists/*

# GitHub CLI — authenticates automatically from the GITHUB_TOKEN env var
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends gh && \
    rm -rf /var/lib/apt/lists/*

# Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# pnpm and yarn, for repos that use them instead of npm (bundled with Node, just switched off by default)
RUN corepack enable
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src ./src

# Persistent volumes (mount these in Coolify):
#   /data/claude-config  -> holds `claude login` OAuth credentials
#   /data/workspaces     -> cloned repos, reused between runs
RUN mkdir -p /data/claude-config /data/workspaces

ENV CLAUDE_CONFIG_DIR=/data/claude-config
ENV WORKSPACE_DIR=/data/workspaces

CMD ["node", "src/index.js"]
