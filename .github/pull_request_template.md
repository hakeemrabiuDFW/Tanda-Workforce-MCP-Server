<!-- The merge gate (.github/scripts/gate.sh) requires every heading below. -->

## Summary

Closes #

What changed and why, in a few lines.

## Evidence

- [ ] `npm run lint`, `npx tsc --noEmit`, `npm test`, `npm run build` pass locally
- [ ] Tests added for the change, including the failure path
- Staging live test (after merge to `staging`): result of `npm run smoke` and the issue's acceptance check

## Merge Danger

**Door:** one-way / two-way (can this be rolled back by redeploying the previous image?)

**Blast Radius:** which tools, env vars or users are affected if this is wrong
