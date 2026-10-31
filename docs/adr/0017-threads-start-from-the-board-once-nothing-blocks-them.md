# Threads start from the board, once nothing blocks them

Settled in issue #167.

A shaping thread stops at Ready instead of launching its build, and a concept's decision and build threads start from the board, not from the thread that created them. A part blocked by another issue starts only once that issue closes, by hand or through Start after; this replaces starting every build at once. The user sees what is ready and decides when each thread starts, so no thread sits waiting for them to say continue, and no build runs against work that may still change. The cost is one click per build, and coupled builds run one after another instead of side by side.

Amended by [ADR 0036](0036-factory-progress-stays-on-the-machine.md): a blocked part starts once the work it waits on is complete in its work records. A closed ticket, a Status or a finished T3 turn completes nothing.

Amended by [ADR 0043](0043-work-another-team-delivers-is-a-dependency-not-a-build.md): a part that needs a Dependency starts only once the user marks it met. The user's decision stands over any close the board observes on the Dependency's ticket.
