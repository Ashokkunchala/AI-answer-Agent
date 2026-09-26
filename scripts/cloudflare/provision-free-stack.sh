#!/usr/bin/env bash
set -euo pipefail

# Provision the free-first Cloudflare resources used by AI-Answer-Agent.
# This script does not deploy the Worker or touch existing resources.
# Review the output before applying migrations/bindings.

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$PROJECT_ROOT/packages/worker"

command -v npx >/dev/null || { echo "Node/npm/npx is required"; exit 1; }

echo "== AI-Answer-Agent Cloudflare free-first resources =="

echo "Creating AI cache KV namespace..."
npx wrangler kv namespace create AI_CACHE || true

echo "Creating D1 database (reuse an existing one if already present)..."
npx wrangler d1 create ai-answer-agent || true

echo "Creating R2 bucket (reuse an existing one if already present)..."
npx wrangler r2 bucket create ai-answer-agent-assets || true

echo "Creating interview queue..."
npx wrangler queues create ai-answer-agent-interview || true

echo
cat <<'EOF'
Next steps:
  1. Copy the returned IDs into wrangler.free.example.toml.
  2. Export InterviewSession and InterviewAnalysisWorkflow from src/index.js.
  3. Uncomment the Durable Object / Queue / Workflow bindings.
  4. Apply D1 migrations:
       npx wrangler d1 migrations apply ai-answer-agent --remote
  5. Put AI Gateway secrets only if you intentionally use an external provider:
       npx wrangler secret put GATEWAY_API_TOKEN
  6. Deploy:
       npx wrangler deploy

Never commit API tokens or other secrets.
EOF
