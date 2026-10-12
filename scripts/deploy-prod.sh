#!/usr/bin/env bash
# Deploy a branch or commit to the production host, with one-step rollback.
#
# Runs ON the prod host; pipe it over ssh from the dev box:
#   ssh andreas@10.10.0.12 'bash -s -- channel/cast-next' < scripts/deploy-prod.sh
#   ssh andreas@10.10.0.12 'bash -s -- main'               < scripts/deploy-prod.sh
#   ssh andreas@10.10.0.12 'bash -s -- --rollback'         < scripts/deploy-prod.sh
#   ssh andreas@10.10.0.12 'bash -s -- --status'           < scripts/deploy-prod.sh
#
# The ref is a branch on origin or a commit SHA. The checkout is left detached
# at that commit, so use this script (not `git pull`) for later updates.
#
# Safety:
# - refuses to run over uncommitted changes to tracked files;
# - builds into dist-next first, so a failed typecheck/build leaves the running
#   site and dist/ untouched (the server caches dist/index.html at startup, and
#   a build that empties dist/ under it breaks the page);
# - keeps the previous build in dist-prev for an instant rollback;
# - health-checks /api/health after the restart and rolls back on failure.
# `ssh host 'cmd'` runs a non-interactive shell that skips ~/.bashrc, where nvm
# and npm-global PATH entries usually live. Load them before strict mode, since
# these files are not written for `set -u`.
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true
[ -f "$HOME/.profile" ] && . "$HOME/.profile" >/dev/null 2>&1 || true
export PATH="$HOME/.npm-global/bin:$HOME/.local/bin:/usr/local/bin:$PATH"

set -euo pipefail

APP_DIR="${AURORA_DIR:-$HOME/NorthernLights}"
ARG="${1:?usage: deploy-prod.sh <branch|sha> | --rollback | --status}"
cd "$APP_DIR"
mkdir -p logs
HISTORY="logs/deploy-history.log"

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

pm2_name() {
  command -v pm2 >/dev/null 2>&1 || die "pm2 is not on PATH for this ssh session (node: $(command -v node || echo none); PATH=$PATH)"
  if [ -n "${AURORA_PM2_NAME:-}" ]; then echo "$AURORA_PM2_NAME"; return; fi
  for name in aurora northernlights; do
    if pm2 describe "$name" >/dev/null 2>&1; then echo "$name"; return; fi
  done
  pm2 ls >&2 || true
  die "no pm2 process named aurora or northernlights (listed above); rerun with AURORA_PM2_NAME=<name> before bash -s"
}
NAME="$(pm2_name)"
PORT="$( (grep -E '^PORT=' .env 2>/dev/null || true) | tail -n 1 | cut -d= -f2 | tr -d '"'"'"' ')"
PORT="${PORT:-3001}"

current_sha() { git rev-parse HEAD; }

health() {
  local code
  for _ in $(seq 1 45); do
    code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/api/health" || true)"
    if [ "$code" = "200" ]; then return 0; fi
    sleep 2
  done
  return 1
}

install_deps_if_changed() { # $1 = previous sha
  if ! git diff --quiet "$1" HEAD -- package.json package-lock.json; then
    say "package-lock changed; npm ci"
    npm ci
  fi
}

build_into_next() {
  rm -rf dist-next
  say "typecheck"
  npx tsc --noEmit
  say "build into dist-next"
  VITE_CONFIG_NATIVE_IGNORE_WARNING=true npx vite build --outDir dist-next --emptyOutDir
  current_sha > dist-next/.aurora-commit
}

swap_in_next() {
  rm -rf dist-prev
  if [ -d dist ]; then mv dist dist-prev; fi
  mv dist-next dist
}

restart_and_check() {
  say "pm2 restart $NAME"
  pm2 restart "$NAME" >/dev/null
  say "waiting for http://127.0.0.1:${PORT}/api/health"
  health
}

status() {
  echo "app dir:   $APP_DIR"
  echo "pm2:       $NAME (port $PORT)"
  echo "commit:    $(git log -1 --format='%h %s (%cr)')"
  echo "dist:      $(cat dist/.aurora-commit 2>/dev/null || echo unknown)"
  echo "dist-prev: $(cat dist-prev/.aurora-commit 2>/dev/null || echo none)"
  echo "bundle:    $(curl -s "http://127.0.0.1:${PORT}/" | grep -oE 'assets/index-[A-Za-z0-9_-]+\.js' | head -n 1 || true)"
  echo "history:"; tail -n 5 "$HISTORY" 2>/dev/null || echo "  (none)"
}

if [ "$ARG" = "--status" ]; then status; exit 0; fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  git status --short --untracked-files=no
  die "uncommitted changes to tracked files on the prod host; resolve them first"
fi

FROM="$(current_sha)"

if [ "$ARG" = "--rollback" ]; then
  [ -s "$HISTORY" ] || die "no deploy history to roll back"
  TARGET="$(tail -n 1 "$HISTORY" | awk '{print $2}')"
  [ -n "$TARGET" ] || die "could not read the previous commit from $HISTORY"
  LABEL="rollback"
else
  say "fetch origin"
  git fetch --prune origin
  if TARGET="$(git rev-parse --verify -q "origin/${ARG}^{commit}")"; then :
  elif TARGET="$(git rev-parse --verify -q "${ARG}^{commit}")"; then :
  else die "unknown branch or commit: $ARG"; fi
  LABEL="$ARG"
fi

if [ "$TARGET" = "$FROM" ] && [ "$(cat dist/.aurora-commit 2>/dev/null || true)" = "$FROM" ]; then
  say "already at $(git log -1 --format='%h %s' "$TARGET"); nothing to do"
  exit 0
fi

say "deploying $LABEL: $(git log -1 --format='%h' "$FROM") -> $(git log -1 --format='%h %s' "$TARGET")"
git checkout -q --detach "$TARGET"
install_deps_if_changed "$FROM"

if [ "$LABEL" = "rollback" ] && [ "$(cat dist-prev/.aurora-commit 2>/dev/null || true)" = "$TARGET" ]; then
  say "reusing the previous build from dist-prev"
  rm -rf dist-next
  mv dist-prev dist-next
else
  if ! build_into_next; then
    say "build failed; restoring $FROM (the running site was not touched)"
    rm -rf dist-next
    git checkout -q --detach "$FROM"
    install_deps_if_changed "$TARGET"
    die "build failed for $LABEL"
  fi
fi

swap_in_next
if restart_and_check; then
  echo "$(date -u +%FT%TZ) $FROM $TARGET $LABEL" >> "$HISTORY"
  say "deployed"
  status
  exit 0
fi

say "health check failed; rolling back to $FROM"
git checkout -q --detach "$FROM"
install_deps_if_changed "$TARGET"
if [ "$(cat dist-prev/.aurora-commit 2>/dev/null || true)" = "$FROM" ]; then
  rm -rf dist-next && mv dist dist-next && mv dist-prev dist && rm -rf dist-next
else
  build_into_next && swap_in_next
fi
pm2 restart "$NAME" >/dev/null
health && say "rolled back to $(git log -1 --format='%h %s')" || say "rollback restarted, but /api/health is still failing; check: pm2 logs $NAME"
exit 1
