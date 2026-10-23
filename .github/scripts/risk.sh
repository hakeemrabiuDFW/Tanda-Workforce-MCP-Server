#!/bin/bash
# risk.sh: classify a PR by the paths it touches. Reads one path per line on
# stdin (include the old path of renames) and prints low, medium or high.
#
#   high    .github/, .githooks/, the pipeline's own rules (scripts/checks.sh,
#           CODING_STANDARDS.md, .markdownlint*), or a path containing
#           secret/token/env/key
#   low     only *.md, tasks/, docs/ (GLOSSARY.md is *.md)
#   medium  anything else
#
# Matching is case-insensitive and deliberately broad: a false "high" only
# means a human merges it. An empty list is "high" (nothing to judge).

set -u
shopt -s nocasematch

risk=""
while IFS= read -r path; do
  [ -n "$path" ] || continue
  case "$path" in
    .github/*|.githooks/*|scripts/checks.sh|CODING_STANDARDS.md|.markdownlint*) echo high; exit 0 ;;
    *secret*|*token*|*env*|*key*) echo high; exit 0 ;;
    *.md|tasks/*|docs/*) risk="${risk:-low}" ;;
    *) risk=medium ;;
  esac
done

echo "${risk:-high}"
