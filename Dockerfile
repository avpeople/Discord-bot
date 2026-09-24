FROM node:20-slim

# git is needed for repo operations; ca-certificates for HTTPS clone
RUN apt-get update && \
    apt-get install -y --no-install-recommends git ca-certificates curl && \
    rm -rf /var/lib/apt/lists/*

# Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

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
