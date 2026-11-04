#!/usr/bin/env bash
# Deploys the relay to Google Cloud Run in Europe: Gemini does not serve Russia, a relay in the EU does.
# Settings and the key are read from relay/.env (ignored by git) and passed to Cloud Run as environment variables.
# Usage: relay/deploy-cloudrun.sh [project] [region]
set -euo pipefail
cd "$(dirname "$0")/.."
PROJECT="${1:-kluch-513609}"
REGION="${2:-europe-west4}"
SERVICE="apron-relay"
GCLOUD="${GCLOUD:-$(command -v gcloud || echo "$HOME/apron-tools/google-cloud-sdk/bin/gcloud")}"
[ -f relay/.env ] || { echo "Нет relay/.env: скопируйте relay/.env.example и заполните"; exit 1; }

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/src/relay" "$WORK/src/prompts"
cp relay/core.mjs relay/server.mjs "$WORK/src/relay/"
cp prompts/inspect-system.md prompts/inspect-schema.json "$WORK/src/prompts/"
cat > "$WORK/src/Dockerfile" <<'DOCKER'
FROM node:22-slim
WORKDIR /app
COPY relay/ relay/
COPY prompts/ prompts/
ENV HOST=0.0.0.0 NODE_ENV=production
USER node
CMD ["node", "relay/server.mjs"]
DOCKER

# Environment for Cloud Run: everything from relay/.env except local-only keys. Cloud Run sets PORT itself.
umask 077
python3 - relay/.env "$WORK/env.yaml" <<'PY'
import sys, json
out = {}
for line in open(sys.argv[1], encoding='utf-8'):
    line = line.strip()
    if not line or line.startswith('#') or '=' not in line: continue
    k, v = line.split('=', 1)
    if k in ('PORT', 'HOST'): continue
    out[k.strip()] = v.strip()
out['TRUST_PROXY'] = '1'  # Cloud Run's front end sets X-Forwarded-For with the phone's address
missing = [k for k in ('PROVIDER', 'MODEL', 'API_KEY', 'ALLOWED_ORIGINS') if not out.get(k)]
if missing: sys.exit('В relay/.env не заполнено: ' + ', '.join(missing))
with open(sys.argv[2], 'w', encoding='utf-8') as f:
    for k, v in out.items(): f.write(k + ': ' + json.dumps(v) + '\n')
PY

"$GCLOUD" services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com --project "$PROJECT" --quiet
# One warm instance keeps the first photo on stage fast; set --min-instances 0 after the pitch to stop paying for idle time.
"$GCLOUD" run deploy "$SERVICE" --source "$WORK/src" --project "$PROJECT" --region "$REGION" \
  --allow-unauthenticated --env-vars-file "$WORK/env.yaml" \
  --min-instances 1 --max-instances 3 --memory 256Mi --cpu 1 --concurrency 40 --timeout 30 --quiet
URL="$("$GCLOUD" run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --format 'value(status.url)')"
echo
echo "Relay: $URL"
echo "Проверка: $URL/health"
echo "В assets/core.js: analyzeUrl: '$URL/inspect'"
