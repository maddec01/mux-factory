# Start in the issue's repository project

Issue #116 moved board Start from the shared `~/Developer/lar` T3 project (ADR 0003) to the issue's repository project, so a thread lives with the code it is about and every repository listed in `config.json` works without a shared parent folder. The board finds that project from a required checkout path per repository, then checks T3's database read-only for a live project there. It refuses with a hint rather than registering one, so the board never changes T3. Work spanning repositories still becomes one build per repository, launched by lar-work in each repository project.

ADR 0010 supersedes the checkout-path lookup: the board now finds the project by git origin.

Amended by [ADR 0043](0043-work-another-team-delivers-is-a-dependency-not-a-build.md): work spanning repositories becomes one build per onboarded repository, and a change another team delivers elsewhere is a Dependency, not a build.
