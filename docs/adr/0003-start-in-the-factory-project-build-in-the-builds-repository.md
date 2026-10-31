---
status: superseded by ADR-0009
---

# Start in the factory project; build in the build's repository

[Issue #9's confirmed brief](https://github.com/maddec01/lar-factory/issues/9)
places board Start in the factory's shared T3 project: it launches a thread with
the issue's **work message** (`#n title`, then `$lar-work owner/repo#n`; first
`/lar-work owner/repo#n` in
[commit 3fef010](https://github.com/maddec01/lar-factory/commit/3fef0103641afe76bc954916e473cfeb5e215900),
changed by [issue #55](https://github.com/maddec01/lar-factory/issues/55)),
as described in the [board instructions](../../apps/server/README.md).
The current [lar-work workflow](../../skills/lar-work/SKILL.md#1-pick-up)
shapes an issue when needed, or proceeds directly from a passing brief to
[launching a separate build](../../skills/lar-work/SKILL.md#5-start-the-build)
in its build's repository's project and its own worktree; Start itself leaves
status changes to lar-work.
Each build belongs to exactly one repository and lands as one PR in that
repository's T3 project, settled in
[issue #94](https://github.com/maddec01/lar-factory/issues/94).
Work in another repository becomes a build in that repository, under the issue
that needs it and blocking it, so a request spanning repositories needs no
concept map ([issue #86](https://github.com/maddec01/lar-factory/issues/86)); the benefit of shared planning context
with separate build workspaces is an inference from that arrangement, not a
recorded historical rationale or comparison of alternatives.

Superseded by [ADR 0009](0009-start-in-the-issues-repository-project.md): Start now opens the thread in the issue's repository project.

Amended by [ADR 0043](0043-work-another-team-delivers-is-a-dependency-not-a-build.md): only work in a connected, onboarded repository becomes a build there, and only after the user approves it. A change another team delivers in a repository the user does not onboard is a Dependency in the work record.
