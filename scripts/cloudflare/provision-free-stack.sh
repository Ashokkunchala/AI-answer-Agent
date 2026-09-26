#!/usr/bin/env bash
set -euo pipefail

# Provision the free-first Cloudflare resources used by AI-Answer-Agent.
# This script does not deploy the Worker or touch existing resources.
# Review output before applying migrations/bindings.

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$PROJECT_ROOT/packages/worker"

command -v npx >/dev/null || { echo "Node/npm/npx is required"; exit 1; }

echo "== AI-Answer-Agent Cloudflare free-first resources =="
echo "Creating AI cache KV namespace..."
npx wrangler kv namespace create AI_CACHE || true

echo "Creating D1 database..."
npx wrangler d1 create ai-answer-agent || true

echo "Creating R2 bucket..."
npx wrangler r2 bucket create ai-answer-agent-assets || true

echo "Creating interview queue..."
npx wrangler queues create ai-answer-agent-interview || true

echo "Creating 768-dimensional semantic context index..."
npx wrangler vectorize create ai-answer-agent-context --dimensions=768 --metric=cosine || true

echo
cat <<'EOF'
Next steps:
  1. Copy returned KV/D1 IDs into packages/worker/wrangler.toml.
  2. Enable AI_CACHE, INTERVIEW_DB and AI_ASSETS bindings.
  3. Enable INTERVIEW_SESSIONS + its SQLite migration.
  4. Enable INTERVIEW_QUEUE and INTERVIEW_WORKFLOW bindings.
  5. Enable VECTORIZE with index_name = "ai-answer-agent-context".
  6. Apply D1 migrations:
       npx wrangler d1 migrations apply ai-answer-agent --remote
  7. Deploy:
       npx wrangler deploy

Never commit API tokens or other secrets.
EOF
