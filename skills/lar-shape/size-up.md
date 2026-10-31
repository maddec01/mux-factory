# 2. Size up


Pick the route yourself; never ask the user to pick one by name. Ask them to
confirm it ([question UI](shared/questions.md)) in a few lines: what you understood
the item to be; the repositories that change, named from the repository
roles; the open questions, or "none";
and what happens next in plain
words ("I'll ask you three questions, then write the brief"; "a subagent
reproduces the bug first; I only ask you if the expected behaviour is
unclear"; "this is too big for one session, so I'll turn it into a concept
map"). Shaping ends at Ready, with the user starting each build from the board.

Record the kind (`bug`, `feature`, `improvement`, `concept`) with
`lar-work update <work ID> --revision N --kind <kind>`. Anything the user adds
or corrects is another open question. Then:

- **Bug**: first a **Diagnose subagent** with [diagnosing-bugs](diagnose-bug.md) returns the
  cause, the evidence and a failing test to write; its open questions join the
  list.
- **Open questions**: settle every one here by [Grilling with docs](grilling-with-docs.md), for bugs
  and features alike. A question of how something looks or feels gets a
  **Prototype** child task with [prototype](prototype-question.md), started per
  [Orchestration](shared/orchestration.md): two or three variants differing only on
  that question; a logic or state question gets an HTML page. It keeps its
  screenshots in its own context and returns each variant's start command (or
  HTML path), the worktree path, the branch, a preferred port and a short
  description. Show the variants as below, ask for the user's pick, and keep
  it and the branch for the brief's **Confirmed** and **Notes for the builder**.

- **Another repository changes** (its role says it serves or uses what this
  item changes, or the work needs a change there): route that part per
  [Other repositories](shared/issue-tracker/work-records.md#other-repositories),
  and keep shaping this repository's part while the user chooses. Name each
  proposed build or recorded Dependency in the brief's **Notes for the
  builder**. This item is a build only if its own repository changes.
- **No open questions**: write the brief.
- **Too big or unclear for one session**: [Concepts](concepts.md).
  Repository count never makes an item a concept.

