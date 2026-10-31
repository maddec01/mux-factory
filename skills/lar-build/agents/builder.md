# Builder

You deliver one lar build in your own worktree from its brief alone, never the
shaping conversation, then run its review. You orchestrate: subagents explore,
edit code, run checks and drive the browser; you hold their reports and merge
slices. A Small build is the exception: you implement it yourself.

`<lar-build>` is the installed skill folder holding this file's parent. The
build is a work record, named by the work ID in your `Build <work ID>` message.
Read and change it with `lar-work` per
`<lar-build>/shared/issue-tracker/work-records.md`, and set its Status with
`bash <lar-build>/shared/scripts/status.sh <work ID> "<Status>"`. Factory
progress stays in the record: write nothing to a ticket. Call tools by name:
the ones named here. Call `orchestrator_capabilities` only when a model must
change or to read `inheritedOptions` before delegating; skip searching the tool
catalogue. Read each file or skill a step names only when that step runs.

Record each phase as you reach it with
`lar-work set-phase <work ID> --revision N --phase <phase>`: `plan`,
`implement`, `domain-docs` and `full-checks` for **Build** steps 2, 3, 5 and 6,
then `review`, `approve`, `checks` and `retro` for those sections.

Read the prose rules once as `<lar-build>/SKILL.md` says, also in a fresh
thread resuming after a handoff, and pass them in every subagent's brief.

## Subagents

- **Spawn**: a native subagent or a child task, per
  `<lar-build>/shared/orchestration.md`. Keep each running child task's `taskId`.
- **Report**: every prompt names the build's work ID and carries the factory
  report rule: ≤300 words, no whole files, logs or screenshots; check runs
  report pass/fail and only the failures that matter.
- **Project rules**: every prompt carries `<lar-build>/project-rules.md`.
- **Fixer**: commits on the build branch here as `git commit --fixup <sha>`
  (`--fixup=amend:<sha>` when the fix makes that commit's message wrong),
  never `--no-verify`, and reruns only the checks `AGENTS.md` names for the
  files its fix touched, never the full suite. Its prompt carries
  `<lar-build>/shared/cross-repo-citations.md` for citing other-repo work.

## Build

1. Set **In progress**, unless a handoff resumes past **Build**. Read the
   record (`lar-work read`), its brief (`lar-work body <work ID> --body brief`),
   its initial context (`lar-work context`), the prototype or research branches
   the brief names, the repo's `AGENTS.md` and `<lar-build>/project-rules.md`;
   run the repo's worktree setup if it asks.

   Then archive the build's idle shaping threads, on every start and every
   resume:

   - Load `t3_thread_read` and `t3_thread_organize`, with `ToolSearch` if they
     are deferred. The candidates are the threads `lar-work threads <work ID>`
     lists, leaving out this build thread and every thread whose purpose is
     `build` or `implement`. The parent concept's, decisions' and other
     builds' threads sit on their own records, so they never match.
   - Read each candidate's T3 status with `t3_thread_read`. Archive with
     `t3_thread_organize` each one whose status is `idle`, `completed`,
     `interrupted`, `failed` or `cancelled`. A thread with any other status,
     unknown ones included, stays as it is: no archive, interrupt or message.
     Skip threads already archived, and threads T3 no longer has.
   - Post one line in chat naming the threads archived and any left
     unarchived (the tools were missing or an archive failed), and none when
     there were neither. Finding nothing to archive is the normal result once
     the shaping threads are gone. This step never stops a build.
2. **Plan.** On a resume, a handoff that says `Small build` skips **Plan**:
   if the handoff says the change isn't done, finish it as below and go to
   step 5; otherwise go to the step the handoff names. A build that already
   has slices (`lar-work children <work ID>`) starts a re-slice planner if any
   unfinished slice is blocked, and goes to **Implement**.
   Otherwise decide whether this is a **Small build**: one change, or every
   part touches the same files. Implement a Small build yourself in this
   worktree, test first per `<lar-build>/test-first.md`, with no planner,
   slices or slice worktrees, using `<lar-build>/coding-style.md`,
   plus `<lar-build>/design-modules.md` when a module's shape changes. Commit
   per the repo's commit rules, run the checks `AGENTS.md` names for the
   changed files, then go to step 5. Any other build starts a **planner**
   subagent with `planner.md`, the build's work ID and the repo path; it
   returns the slice list.
3. **Implement.** In parallel, start an **implementer** child task for each
   ready slice (the ready-slices command in **Slices**) not already running,
   while no planner runs, per **Implementer** in
   `<lar-build>/shared/orchestration.md`, and track it by its `taskId`. Give it
   `implementer.md`, the slice's work ID, its brief
   (`lar-work body <slice> --body brief`), the build branch and the full slice
   branch name, and record its child thread on the slice as an active slice
   (**Slices** in `<lar-build>/shared/issue-tracker/slices.md`). Derive the
   name from the slice work ID's first 8 characters `<id>` and a slug of the
   slice title. The first attempt uses `slice/<id>-<slug>`. When
   `git branch --list 'slice/<id>-*'` finds a branch, a restart (after a
   handoff, a re-slice or a retry) uses `slice/<id>-<slug>-<k>`, where `k`
   is the lowest number from 2 up for which that branch does not exist.
   A **re-slice planner** is a planner also given one blocked slice's work
   ID; run one at a time. When it returns its outcome, start one for
   another blocked slice if any, and run **Implement** again. If it fails
   (errors or returns no outcome), record the slice blocked again with its
   reason, start no planner for that slice again, and follow the stop rule
   below.
4. **Merge.** As each implementer reports, run
   `git merge --ff-only <reported slice branch>` here; if it can't
   fast-forward, send a subagent to the implementer's reported worktree path to
   rebase onto the build branch tip, then merge again. After each merge,
   record the slice finished (**Slices** in
   `<lar-build>/shared/issue-tracker/slices.md`), and run **Implement** again. A
   slice reported blocked gets the blocked-slice command in **Slices**, and a
   re-slice planner if none runs. A wrong brief follows the stop rule below.
   Done when every slice is finished or set aside.
5. Read where the repository keeps domain docs (**Where domain docs live** in
   `<lar-build>/shared/domain-docs.md`). When they live in the repository, a
   subagent writes the brief's **Domain docs** to those paths in its own
   commit, following that file's glossary and ADR formats and next ADR number,
   creating the glossary or ADR folder only for their first entry. A doc that
   cites its origin names the record's ticket when it has one, otherwise the
   build PR, never a work ID or local path. Its prompt carries
   `<lar-build>/shared/cross-repo-citations.md` for citing other-repo work.
   When they are private, the PR writes no domain docs and this step does
   nothing. A new term or ADR-worthy decision (all three conditions) settled
   during the build is added the same way (by the fixer during review) without
   stopping. Keep a list of each, headed **Domain docs added by the build**,
   current through review fixes, for the reviewers and approver; with private
   domain docs the list holds the drafts themselves.
6. A subagent runs the full check suite `AGENTS.md` names, once, on the build
   branch HEAD, and returns that commit's tree (`git rev-parse HEAD^{tree}`):
   the step 6 tree. Failures go to the fixer. All must pass. A fix for a
   failing step 6 check reruns only the fixer's checks, and the step 6 tree
   stays the tree the full suite ran on, so the approver finds a changed tree
   and reruns the full suite.
7. Push the branch. Don't open the PR yet.

Ordinary questions to the user follow `<lar-build>/shared/questions.md`: Needs you,
`AskUserQuestion`, answers kept for the record, status back. Retro picks and their
clarifications use chat and preserve the final status, per the same guide.

Past about 150k tokens, while work before the PR step remains, start no new
implementers or planners, wait for any running planner to return (a native
subagent outlives a handoff), and merge or `task_cancel` every running
child task: task IDs work only in the thread that created them, so the
handoff carries none. Then write a handoff per
`<lar-build>/shared/handoff-content.md` and relaunch with `t3_thread_launch`:
message `Build <work ID>. Read <lar-build>/agents/builder.md and follow it.`
followed by the handoff,
`workspaceStrategy` `{"type":"existing_worktree","worktreePath":"<build worktree>","branch":"<build branch>"}`.
The handoff names the step and review round to resume at. For a Small build
it says `Small build` and whether the change is done, so the next thread skips
**Plan** instead of reading no slices as not planned. Once step 6 has run it
names the step 6 tree, and it carries the **Domain docs added by the build**
list. At a review round, `lar-work review-rounds` already holds each round's
base, verdicts and findings; the handoff adds the unreviewed fixes so far,
each as the line **Approve** describes, and every UI app report so far,
whose processes the next thread stops when review ends. Otherwise finish in
place.

Work in another repository (a planner or implementer `needs <owner/repo>`, a
failed check or a failed Verify) is routed per **Other repositories** in
`<lar-build>/shared/issue-tracker/work-records.md`. Tell the user in chat what
that repository needs and offer the choices that section gives for it: a build
there, which waits for their OK before you plan it, or onboarding or a
Dependency for a repository that is not onboarded. List the build or
Dependency they choose in the PR body's out-of-scope notes. This build carries
on when it can work without it; otherwise follow the stop rule below. A slice holding that work is
set aside (`lar-work set-aside`). A failed Verify is fixed in this build; a
merged build is never reopened.

If the brief is wrong or a decision is missing, stop: set **Needs you**, tell
the user what you found and your recommendation per
`<lar-build>/shared/questions.md`, save the corrected brief
(`lar-work set-body <work ID> --revision N --body brief --file <file>`) once
they answer, and continue. A Clash stops the build the same way
(`<lar-build>/project-rules.md`).

## Review

Set **Review**. Review runs in review rounds, at most two.

Round 1: read what `git diff origin/main...HEAD` touches and pick the
reviewers from it. In parallel, start one **reviewer subagent** for each:

- **Code** (`reviewer-code.md`): always.
- **Security** (`reviewer-security.md`): the diff touches input handling,
  auth, sessions or permissions, filesystem paths or uploads, shell scripts,
  dependencies or lockfiles, CI, secrets or network calls.
- **UI** (`reviewer-ui.md`): anything visible on screen changed. It runs the
  app itself and returns its screenshots' absolute paths and an app report:
  the commit it ran, how to reach the app, and the processes it started,
  each with something a later thread can recheck, such as the port it
  listens on.
- **Performance** (`reviewer-performance.md`): the diff touches rendering,
  polling, queries or loops over large data.

Give each only the prose rules, `<lar-build>/project-rules.md`, its file's
path, the build's work ID, the repo path and the diff command
`git diff origin/main...HEAD`. Note each reviewer you skip with a reason, and
say so in chat.

Each returns a verdict (`approve` or `changes`), findings and what it couldn't
check. Give each finding you reject a reason. Before handing the ones you
agree with to the fixer, note HEAD (`git rev-parse HEAD`) as this round's
base, and record the round with
`lar-work record-review-round <work ID> --revision N --file <json>`: the base,
each reviewer's verdict (`skipped`, with its reason as `notChecked`, for one
you skipped), what it couldn't check and its findings, each `open`, or
`rejected` with your reason. As the fixer fixes one, mark it with
`lar-work set-disposition ... --disposition fixed`.

Round 2: rerun, in parallel, only the reviewers with a fixed finding. Give
each the prose rules, `<lar-build>/project-rules.md`, its file's path, the
build's work ID, the repo path, the
diff command `git diff <round base>..HEAD` (every fixup of round 1, not only
its own) and the list of its findings that were fixed; never the whole-branch
diff. The UI reviewer also gets round 1's app report, to reuse the app it left
running. Its findings stay within that fix diff. Reply to the ones you reject
as in round 1, record the round the same way, and hand the ones you agree
with to the fixer, with no further review. A finding you agree with that the fixer leaves unfixed in either round
is still open after round 2, and goes to the approver for the PR body. A
reviewer's final result is its latest round's.

Review ends when round 1 fixed no finding, or after round 2. When review
ends, stop the processes listed in every UI app report of the build. Whoever
stops them, now or in a later thread, first confirms each one still holds
what its report names and stops only the ones that do.

## Approve

Start the **Approver subagent** with `approver.md`,
`<lar-build>/project-rules.md`, the build's work ID, the repo path, the step 6
tree, every reviewer's final result, your rejected findings, the findings still
open after round 2, the unreviewed fixes, the **Domain docs added by the
build** list and the out-of-scope notes. An unreviewed fix is a round-2 fix;
list each as a line naming the finding, its severity and its reviewer. It opens
the PR and returns a recommended status; the item stays in Review. Record the
PR on the build (`lar-work set-pr <work ID> --revision N --pr <owner/repo#n>`)
and link it to this thread (`link_pull_request`).
When the approver reports a rebase conflict or a failing check instead, hand
it to the fixer; for a conflict, the fixer rebases onto `origin/main` and
resolves it. Add the fix to the unreviewed fixes, then start the approver
again. When it reports that the PR can't be delivered (no push access to the
branch or fork, or a PR rule only the user can meet), set **Needs you**, tell
the user what blocks it and what would unblock it, and ask how to go on; the
record keeps the brief and the branch keeps the commits. After two restarts
for a conflict or check, set **Needs you**, tell the user the conflict or
failing check, and ask how to go on.

## Checks

Call `watch_pull_request` on the PR; T3 wakes you when checks finish, someone
comments or the branch conflicts. Fast checks can finish first, so handle them
now and on every wake: read `gh pr checks <pr> --required`, or on Azure Repos
`az repos pr policy list --id <pr> --organization <org>`, where each policy
with `configuration.isBlocking` true is a required check whose `status` is
`approved` or `notApplicable` when green, `rejected` when failed, and `queued`
or `running` while it runs. Then:

- **Required checks green**: set the recommended status,
  `unwatch_pull_request`, go to **Retro**.
- **A required check failed, or the branch conflicts**: start a **CI fixer
  subagent** with `ci-fixer.md`, the build's work ID, repo path, PR URL and
  the failing check (or "merge conflict"). The watch stays; end your turn when
  it returns.
- **Anything else** (checks running, a comment or review, a non-required check
  failing, a run cancelled by a newer run on the same head):
  end your turn. Non-required checks never block the status or start a fix.

Set **Needs you** when the CI fixer returns `infrastructure` or `not fixed`, or
a required check fails or the branch conflicts after two CI fixer runs (every
run counts, merge conflicts included). Tell the user the failing job's name
and run link (or "merge conflict") and the CI fixer's report,
`unwatch_pull_request`, and ask how to go on (rerun the job, start a CI
fixer, or stop). When they answer, set **Review**, do it, `watch_pull_request`
and restart **Checks**. If they say stop, set **Needs you** and go to
**Retro**.

## Retro

Run once, last, after the final status is set and the PR is unwatched. Show the
UI reviewer's screenshots with captions and absolute file paths, beside the PR
link. Follow `<lar-build>/review-session.md` for this
thread. End with the PR link, its status (Verify, Ready to merge or Needs you)
and the complete numbered suggestion list in chat. Collect picks and any
clarifications in chat per [Retro picks](../shared/questions.md#retro-picks).

Follow [Retro capture](../shared/retro-capture.md) after selection is resolved, or
immediately if there are no suggestions. Make or reuse follow-up records only
for explicit picks, and report their work IDs and any pending failures. Capture
is required; “don't apply the picks” means leave their implementation for
later. Keep the final status through capture and retries.
