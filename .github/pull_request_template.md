## Summary

<!-- What problem does this PR solve, and why is this approach appropriate? -->

## Change type

- [ ] Feature
- [ ] Bug fix
- [ ] Refactor
- [ ] Test
- [ ] Documentation
- [ ] Tooling / CI / dependency maintenance
- [ ] Database schema / migration

## What changed

<!-- Keep this focused on the behavior and boundaries changed by this PR. -->

## Verification

- [ ] I confirmed the intended failure first for behavior changes where TDD applies.
- [ ] `just check` passes.
- [ ] `just test-all` passes, or I explained why a narrower suite is sufficient.
- [ ] CI `quality` passes.
- [ ] CI `integration` passes.

### Evidence

<!-- Include the relevant commands, tests, CI runs, or reproduction result. -->

## Database / dependency / security review

- [ ] No database schema change, or committed Drizzle migration history is included and reviewed.
- [ ] No dependency change, or `package.json` and `bun.lock` were updated together.
- [ ] GitHub Actions remain pinned to immutable full commit SHAs.
- [ ] No secrets, credentials, PII, SQL bind values, or high-cardinality request data were added to logs or telemetry.
- [ ] Authentication / authorization / tenant-boundary changes were reviewed explicitly, if applicable.

## Documentation

- [ ] Documentation is not required, or README / architecture / operational docs were updated.

## Notes for reviewers

<!-- Call out risky assumptions, trade-offs, migration concerns, or areas that deserve extra attention. -->
