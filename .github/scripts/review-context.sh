#!/bin/bash
# review-context.sh: write what the Claude reviewers need into .review/
#   pr.md       title, author and description
#   diff.patch  the PR's diff against its base
#   issues.md   issues the PR closes (Closes #N), with their comments
# Needs GH_TOKEN, PR and BASE_SHA; run from the checked-out PR.

set -euo pipefail

mkdir -p .review
gh pr view "$PR" --json title,author,body \
  --jq '"# \(.title)\n\nAuthor: \(.author.login)\n\n\(.body)"' > .review/pr.md
git diff "$BASE_SHA"...HEAD > .review/diff.patch

# GitHub only links "Closes #N" for PRs into the default branch, so PRs into
# staging also get their issues from the "Closes/Fixes/Resolves #N" lines in the body.
issues=$( {
  gh pr view "$PR" --json closingIssuesReferences --jq '.closingIssuesReferences[].number'
  gh pr view "$PR" --json body --jq '.body // ""' |
    grep -oiE '\b(close[sd]?|fix(e[sd])?|resolve[sd]?)[[:space:]]+#[0-9]+' | grep -oE '[0-9]+' || true
} | sort -un)
if [ -z "$issues" ]; then
  echo "No linked issue: the PR description does not say Closes #N." > .review/issues.md
else
  : > .review/issues.md
  for n in $issues; do
    gh issue view "$n" --json number,title,body,comments \
      --jq '"# #\(.number) \(.title)\n\n\(.body)\n\n## Comments\n\n\([.comments[] | "- \(.author.login): \(.body)"] | join("\n"))\n"' \
      >> .review/issues.md
  done
fi

wc -c .review/*
