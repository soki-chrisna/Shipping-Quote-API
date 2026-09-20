#!/usr/bin/env bash
# Ubuntu VPS. Existing container is retained until replacement passes health checks.
set -Eeuo pipefail

image="${1:?Usage: deploy.sh ghcr.io/owner/repo@sha256:digest}"

[[ "$image" =~ ^ghcr.io/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$ ]] || exit 2

env_file="$HOME/shipping-quote.env"
test -f "$env_file"

# Prevent concurrent/manual deploys from racing container renames.
exec 9>"$HOME/.shipping-quote-deploy.lock"
flock -n 9

docker pull "$image"

if docker container inspect shipping-quote-previous >/dev/null 2>&1; then
  echo 'Previous backup exists; inspect and resolve it before deploying.' >&2
  exit 1
fi

had_previous=false

if docker container inspect shipping-quote >/dev/null 2>&1; then
  docker stop shipping-quote
  docker rename shipping-quote shipping-quote-previous
  had_previous=true
fi

rollback() {
  docker rm -f shipping-quote >/dev/null 2>&1 || true

  if "$had_previous"; then
    docker rename shipping-quote-previous shipping-quote
    docker start shipping-quote
  fi
}

trap rollback ERR

docker run -d --name shipping-quote --restart unless-stopped \
  --read-only --cap-drop ALL --security-opt no-new-privileges \
  --memory 128m --cpus 1 --pids-limit 100 \
  --log-opt max-size=10m --log-opt max-file=3 \
  -p 127.0.0.1:3000:3000 --env-file "$env_file" "$image"

healthy=false

for attempt in $(seq 1 30); do
  if [ "$(docker inspect --format='{{.State.Health.Status}}' shipping-quote)" = healthy ]; then
    healthy=true
    break
  fi
  sleep 2
done

if ! "$healthy"; then
  echo 'Health check failed; restoring previous container.' >&2
  false
fi

trap - ERR

if "$had_previous"; then
  docker rm shipping-quote-previous
fi

echo "Deployed $image"
