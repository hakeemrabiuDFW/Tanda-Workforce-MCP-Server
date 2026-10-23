#!/bin/bash
# gate.sh: decide what happens to a PR once pr-pipeline.yml has finished.
# Runs from main's copy (pr-gate.yml), so a PR cannot loosen the rules it is
# judged by. Labels risk:*, posts each reviewer's comment, then merges
# (AUTO_MERGE=true), says it would (dry run), or labels ready-for-human.
#
# Env: GH_TOKEN REPO HEAD_SHA RUN_CONCLUSION RUN_URL VERDICT_DIR
#      AUTO_MERGE AUTO_MERGE_MAX_RISK OWNER_LOGIN

set -euo pipefail
here=$(dirname "$0")
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

case "$AUTO_MERGE_MAX_RISK" in
  low|medium) ;;
  *) echo "gate: AUTO_MERGE_MAX_RISK must be low or medium, got $AUTO_MERGE_MAX_RISK" >&2; exit 1 ;;
esac

pr=$(gh pr list --repo "$REPO" --state open --limit 100 --json number,headRefOid \
  --jq ".[] | select(.headRefOid == \"$HEAD_SHA\") | .number" | head -n 1)
if [ -z "$pr" ]; then
  echo "gate: no open PR at $HEAD_SHA (closed, or pushed again since); nothing to do"
  exit 0
fi

pr_json=$(gh pr view "$pr" --repo "$REPO" --json author,isDraft,body)
if [ "$(jq -r .isDraft <<<"$pr_json")" = true ]; then
  echo "gate: PR #$pr is a draft; nothing to do"
  exit 0
fi
author=$(jq -r .author.login <<<"$pr_json")

label() { gh api -X POST "repos/$REPO/issues/$pr/labels" -f "labels[]=$1" >/dev/null; }
# DELETE answers 404 when the label is not on the PR, which is fine.
unlabel() { gh api -X DELETE "repos/$REPO/issues/$pr/labels/$1" >/dev/null 2>&1 || true; }

upsert_comment() { # upsert_comment <marker> <body-file>: edit our last comment with the marker, or add one
  local id
  id=$(gh api --paginate "repos/$REPO/issues/$pr/comments" \
    --jq ".[] | select(.user.login == \"github-actions[bot]\" and (.body | contains(\"<!-- pr-pipeline:$1 -->\"))) | .id" | tail -n 1)
  if [ -n "$id" ]; then
    gh api -X PATCH "repos/$REPO/issues/comments/$id" -F "body=@$2" >/dev/null
  else
    gh api "repos/$REPO/issues/$pr/comments" -F "body=@$2" >/dev/null
  fi
}

# Risk, from the PR's file list as GitHub reports it.
risk=$(gh api --paginate "repos/$REPO/pulls/$pr/files" \
  --jq '.[] | .filename, (.previous_filename // empty)' | "$here/risk.sh")
for level in low medium high; do
  [ "$level" = "$risk" ] || unlabel "risk:$level"
done
label "risk:$risk"

reasons=()
[ "$RUN_CONCLUSION" = success ] ||
  reasons+=("pr-pipeline did not succeed (\`$RUN_CONCLUSION\`): a check failed or a reviewer errored")
[ "$author" = "$OWNER_LOGIN" ] ||
  reasons+=("author is $author, not $OWNER_LOGIN")

# Verdicts from anyone else's PR run are not ours (a fork can upload its own
# artifacts), so they are never read or posted.
for reviewer in standards spec; do
  [ "$author" = "$OWNER_LOGIN" ] || break
  verdict="$VERDICT_DIR/verdict-$reviewer/verdict.json"
  if ! blocking=$(jq -e '[.findings[] | select(.severity == "blocking")] | length' "$verdict" 2>/dev/null); then
    reasons+=("no readable $reviewer verdict (reviewer skipped or failed)")
    continue
  fi
  "$here/render-review.sh" "$verdict" > "$tmp/$reviewer.md"
  upsert_comment "$reviewer" "$tmp/$reviewer.md"
  [ "$blocking" -eq 0 ] || reasons+=("$reviewer reviewer: $blocking blocking finding(s)")
done

# The PR body must follow the mattpocock-skills:pr template.
missing=()
for heading in '## Summary' '## Evidence' '## Merge Danger' '**Door:**' '**Blast Radius:**'; do
  jq -e --arg h "$heading" '.body // "" | contains($h)' <<<"$pr_json" >/dev/null || missing+=("\`$heading\`")
done
[ "${#missing[@]}" -eq 0 ] ||
  reasons+=("PR body is missing PR template parts: ${missing[*]}")

rank() { case "$1" in low) echo 1 ;; medium) echo 2 ;; *) echo 3 ;; esac; }
[ "$(rank "$risk")" -le "$(rank "$AUTO_MERGE_MAX_RISK")" ] ||
  reasons+=("\`risk:$risk\` is above the auto-merge scope (\`$AUTO_MERGE_MAX_RISK\`)")

if [ "$AUTO_MERGE" = true ]; then mode="live"; else mode="dry run"; fi

if [ "${#reasons[@]}" -eq 0 ]; then
  unlabel ready-for-human
  if [ "$AUTO_MERGE" = true ]; then
    gh pr merge "$pr" --repo "$REPO" --squash --delete-branch --match-head-commit "$HEAD_SHA"
    outcome="**Merged** (squash) by the gate."
    result=merged
  else
    outcome="**Dry run: would auto-merge.** Checks passed, both reviewers found nothing blocking, and \`risk:$risk\` is in scope."
    result=would-merge
  fi
else
  label ready-for-human
  outcome="**Needs a human** (labelled \`ready-for-human\`):"
  for reason in "${reasons[@]}"; do outcome+=$'\n'"- $reason"; done
  result=human
fi

cat > "$tmp/gate.md" <<MD
<!-- pr-pipeline:gate -->
### Merge gate

$outcome

Risk \`risk:$risk\` · author $author · mode $mode (max risk \`$AUTO_MERGE_MAX_RISK\`) · [pipeline run]($RUN_URL)

\`GATE: $result head=${HEAD_SHA:0:7}\`
MD
upsert_comment gate "$tmp/gate.md"
echo "gate: PR #$pr -> $result (risk:$risk)"
