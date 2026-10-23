#!/bin/bash
# render-review.sh <verdict.json>: one reviewer's verdict as a PR comment.
# The last line is machine-readable, e.g.
#   VERDICT: standards=PASS blocking=0 non-blocking=2

set -euo pipefail

jq -r '
  (.reviewer | (.[:1] | ascii_upcase) + .[1:]) as $name
  | ([.findings[] | select(.severity == "blocking")] | length) as $b
  | ([.findings[] | select(.severity != "blocking")] | length) as $nb
  | "<!-- pr-pipeline:\(.reviewer) -->",
    "### Claude review: \($name)",
    "",
    .summary,
    "",
    (if (.findings | length) == 0 then "No findings."
     else (.findings[] | "- **[\(.severity)]** \(if .file then "`\(.file)\(if .line then ":\(.line)" else "" end)` " else "" end)**\(.title)**: \(.detail)")
     end),
    "",
    "`VERDICT: \(.reviewer)=\(if $b == 0 then "PASS" else "BLOCK" end) blocking=\($b) non-blocking=\($nb)`"
' "$1"
