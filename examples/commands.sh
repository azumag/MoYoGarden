#!/usr/bin/env bash
set -euo pipefail
BASE_URL="${MOYO_API_URL:-http://127.0.0.1:8787}"
REGION="${MOYO_REGION:-garden-1}"
TOKEN="${MOYO_TOKEN:-}"
AUTH=()
if [[ -n "$TOKEN" ]]; then AUTH=(-H "Authorization: Bearer $TOKEN"); fi
curl -sS "$BASE_URL/api/world/snapshot?region=$REGION" | jq '.tick, .agents[0]'
curl -sS -X POST "$BASE_URL/api/agents/agent-ember-builder/commands?region=$REGION" \
  "${AUTH[@]}" -H 'Content-Type: application/json' \
  -d '{"id":"shell-goal-1","type":"set_goal","goal":"Open a northern trade route"}' | jq
