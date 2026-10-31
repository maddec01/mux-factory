# Work another team delivers is a Dependency, not a build

Settled in [#690](https://github.com/maddec01/lar-factory/issues/690), built in [#696](https://github.com/maddec01/lar-factory/issues/696).

When a needed change belongs to a repository the user does not onboard, the factory records a Dependency in the work record. It records no build, separate work record or bare link, because the factory runs no execution phases or reviews for another team's delivery. A Dependency blocks the builds that need it until the user marks it met.

## Consequences

A Dependency's ticket follows the approved publication and handover rules of [ADR 0042](0042-refinement-publishes-only-finished-work-in-the-teams-terms.md). Only the user marks a Dependency met, because a closed ticket proves neither deployment nor the agreed contract. The user's decision stands over any close the board observes. After that, the factory reads the ticket and its PRs as context and never manages the other team's ticket.

Connections link only onboarded repositories. They are local to the user's machine and have no direction; each repository's role says what it is. A Connection lets refinement propose a build in the other repository, and that build still needs the user's approval.

This amends [ADR 0003](0003-start-in-the-factory-project-build-in-the-builds-repository.md) and [ADR 0009](0009-start-in-the-issues-repository-project.md), which made every change in another repository a build there, and [ADR 0017](0017-threads-start-from-the-board-once-nothing-blocks-them.md), whose blocked parts now also wait on Dependencies.
