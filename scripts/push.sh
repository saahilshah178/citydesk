#!/usr/bin/env bash
# Pushes the current branch to every configured remote (origin and the public mirror).
set -euo pipefail
for remote in $(git remote); do
  git push "$remote" HEAD
done
