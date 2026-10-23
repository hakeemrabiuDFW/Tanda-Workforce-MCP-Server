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

issues=$(gh pr view "$PR" --json closingIssuesReferences --jq '.closingIssuesReferences[].number')
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
