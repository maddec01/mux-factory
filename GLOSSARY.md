# Lar Factory

Lar Factory takes ideas through shaping, building and review to a PR that
the user merges. This vocabulary describes its work, roles and board statuses.

## Language

### Work and handover

**Brief**:
A build's handover, kept in its work record: what to change, how to tell it is
done, confirmed assumptions, builder notes, domain docs drafts and whether the
user needs to verify it.
_Avoid_: Specification (when referring to the factory's brief)

**Domain docs**:
A project's glossary and ADRs. Shaping drafts changes to them in the work
record, and the builder writes them in the build PR, unless the repository
keeps its domain docs as private drafts.

**Prototype**:
A throwaway variant built by a Prototype child task to answer one design
question. The thread that asked for it shows it to the user inside T3, in the
integrated browser or the Device panel, so they can pick one.
_Avoid_: Mockup, draft

**Passing brief**:
A brief that has passed the shaping gate and can be handed to a build thread.

**Gate**:
The check before a brief becomes Ready, combining a fresh-context doubt review
with the user's answers to remaining assumptions or findings.

**Publication**:
Writing fully refined work to the team's tracker as tickets in the team's own
terms, after the user approves the exact content. A concept publishes only
once every decision is settled and every brief has passed the gate.
_Avoid_: sync, export for publication

**Handover**:
The markdown the factory prepares for the user to post when their access cannot
publish it, carrying the same content a published ticket would.

**Vocabulary mapping**:
A repository's local setting that pairs each factory term, concept, build and
each kind, with the team's ticket types, labels or tags, or with nothing.
_Avoid_: label mapping, type mapping

**Concept**:
Work too broad or unclear for a single brief, refined in its work record
through decisions and builds. Once fully refined it can publish as a parent
ticket with one child ticket per build. Spanning several repositories doesn't
by itself make work a concept.

**Map**:
A concept's account, kept in its work record, of its destination, decisions so
far, remaining fog, out-of-scope work, domain docs drafts and relationships
between its parts. Publication carries its destination and decision gists,
never the map itself.

**Build**:
Work in one repository that delivers one standalone PR, recorded on its work
record, through its slices or by the builder alone when it's a Small build.
Parts that only work together are one build.
_Avoid_: build issue

**Small build**:
A build the builder implements itself, without slices, because it's one change
or every part touches the same files.
_Avoid_: quick build, unsliced build

**Slice**:
A small, independently testable piece of a build, kept in the build's work
record and implemented by one implementer. Slices are never published.
_Avoid_: ticket, chunk, task

**Active slice**:
A slice an implementer is working on right now.
_Avoid_: in-progress slice, current slice

**Blocked slice**:
A slice an implementer couldn't finish, waiting for a re-slice. Not a slice
that waits on other work.
_Avoid_: failed slice, stuck slice

**Re-slice**:
A planner's in-place rewrite of a blocked slice and the build's other open
slices that aren't active.
_Avoid_: re-plan

**Work message**:
The two-line text the board sends to a new shaping or decision thread: the item's name, then `$lar-shape <work ID>`.
_Avoid_: work command, `/lar-work` command

**Model choice**:
The provider instance and model a new thread runs on, picked at Start; "T3 default" leaves it to T3.
_Avoid_: model selection, provider setup

**Repository project**:
The T3 project whose folder is a repository's main checkout, recognised by its git origin; a work record's threads run in its repository's project.
_Avoid_: lar project, factory project (for where threads run)

**Repository role**:
A one-line description of what a repository is, such as the API server a client app uses. Onboarding proposes it and the user confirms it.
_Avoid_: relationship, repo type

**Connection**:
The user's local record that two onboarded repositories are related, so refinement can propose a build in one for work captured in the other. It has no direction; each repository's role says what it is.
_Avoid_: relationship, related repo

**Dependency**:
A change the user's work needs in a repository they do not work on, delivered by the team that owns it. It lives in the work record, blocks the builds that need it, and is met when the user marks it met.
_Avoid_: external build, cross-repository build

**Repository config**:
Optional team-shared defaults for one repository's factory setup. Each user can override defaults locally and chooses their own write consent.
_Avoid_: onboarding config, project config, board config

**Onboarding**:
Setting up one repository for the user's factory, including its access, local settings and optional shared settings or repository additions.
_Avoid_: initialization, setup

**Clash**:
A rule or skill setup that prevents factory work from meeting the agreed factory workflow and the project's coding or PR requirements. A different project workflow alone is not a Clash.
_Avoid_: conflict

**Kind**:
The type of an item: bug, feature, improvement or concept, kept in its work record.
Published tickets carry the team term the Vocabulary mapping pairs with it, if any.
_Avoid_: type, work item type

**Custom label**:
A label the user chooses for one repository, such as the part of the product an item touches.
_Avoid_: area label, applicability

**Label group**:
The Custom labels that share the text before ": ", such as `app: music` and `app: video` in the group "app".
_Avoid_: label category, label section

**Work record**:
The factory's record, on the user's machine, of one piece of work the user put on the board: its Status, structure, briefs and decisions, and references to its ticket, T3 threads and PRs. It exists with or without a published ticket.
_Avoid_: personal layer, local state, item for ticketless work

**Launch intent**:
A work record's note that the board asked T3 to start a thread, kept until T3's thread ID is recorded, so the board can find that thread after a crash instead of starting a second one.

**Active work**:
An item whose provider data an agent, a check or the board is changing now. In an Azure DevOps team, which
has no change check that sees every edit, it reads alone every 15 seconds; a repository's issues read only what their
change check finds changed. See ADR 0028.
_Avoid_: Busy item, hot item

### Threads and roles

**User**:
The person who installs the board app and runs the factory on their own repositories.
_Avoid_: owner

**Maintainer**:
The person who keeps lar-factory itself: syncs the skill Copies and Ports with upstream and starts Releases.
_Avoid_: owner, author

**Shaping thread**:
The conversation in the work's repository project that resolves its open
decisions and produces a passing brief, then stops at Ready. Its build thread
archives it once the build starts, unless it is running or needs you.

**Decision thread**:
A top-level thread, started from the board, running `lar-shape` on one decision
a concept's work record owns, in the repository's main checkout, writing only to
work records.
_Avoid_: Decision session

**Build thread**:
The conversation Start build opens in its build's repository project, in its
own worktree, that takes a passing brief through implementation, review and PR
checks.

**Item thread**:
A T3 thread recorded on a work record, whose state is running, needs you,
stopped or done.

**Planner**:
The agent a build thread starts to split its build into slices or to re-slice a
blocked slice.
_Avoid_: slicer, ticket writer

**Child task**:
Delegated work a thread owns and addresses only by its task ID; its backing thread is never used as a conversation.
_Avoid_: delegated thread, child thread

**Subagent**:
An agent a thread's provider starts natively to do part of the thread's work, running in its own thread beneath it.
T3 stores child tasks the same way and tells them apart only by who started them.
_Avoid_: child task (for native subagents), helper

**Reviewer**:
A fresh-context agent assessing a change on one review axis: code, security,
UI or performance.

**Review round**:
One pass of the reviewers over a diff. The first covers the whole branch, and
the second covers only the fixes from the first. A build has at most two.
_Avoid_: Review pass, re-review

**Approver**:
The agent that opens the reviewed change's PR and recommends Verify or Ready
to merge; the user remains the person who merges it.
_Avoid_: Merger (for the approver)

### Board statuses

**Status**:
An item's place in the user's factory workflow, kept in its work record on that user's machine. A team's ticket state and a PR's state are separate facts the factory can read.
_Avoid_: column, state, stage

**List**:
Captured work that has not yet been selected to start.
_Avoid_: Queued (for unselected work)

**Queued**:
Work selected for pickup by lar-shape, by the user or by its concept's shaping,
awaiting a start from the board.
_Avoid_: In progress (for work awaiting pickup)

**Shaping**:
Work whose scope or decisions are being resolved before a build, including a
concept while its decisions remain open.

**Needs you**:
Work waiting for the user's input or intervention, such as an answer, a prototype
choice or help with a blocked check.

**Ready**:
Work with a passing brief, ready for its build to start.
_Avoid_: Ready to merge (for work ready to build)

**In progress**:
Work being implemented by its build thread.

**Review**:
Work undergoing review and any fixes, including the wait for its PR's required
checks before the recommended status takes effect.

**Verify**:
Reviewed work whose required checks have passed and which needs the user's hand
check because it is visible, risky or not fully verified by agents.
_Avoid_: Ready to merge (when a hand check remains)

**Ready to merge**:
Reviewed work whose required checks have passed, with no outstanding findings
or hand checks, awaiting the user's merge.

**Done**:
Completed factory work. A build reaches it when its recorded PR merges, a
decision when its confirmed answer is captured, and a concept when its decisions
are settled, its Fog is gone and all its builds are Done.

**Abandon**:
Setting work aside on the user's machine, keeping its work record for restoring.
The board offers to close the ticket, which waits for the user's OK.
_Avoid_: Cancel, Close (for discarded work)

### Item stats

**Agent time**:
The sum of the work every agent did on an item, with parallel agents added up but a parent's wait on its own subagent counted once, excluding time waiting on the user.
_Avoid_: duration, elapsed time

**Wall time**:
The time during which at least one of an item's agents was working, with parallel work counted once, excluding time waiting on the user.
_Avoid_: elapsed time, calendar time, active time

**Item stats**:
An item's agent time, wall time, total tokens and API cost, shown as four plain figures.
They cover the T3 threads recorded on its work record, with those threads' child tasks and subagents.
_Avoid_: usage, metrics

**Item total**:
An item's stats plus the item total of each of its parts on the board.
_Avoid_: report total, aggregate, rollup

**API cost**:
What an item's tokens would cost at API list prices, as T3 Code estimates it, rather than the subscription bill.
_Avoid_: cost, price

### Board server and page

**Board server**:
The local process that reads each repository's provider and T3 and serves the board.
_Avoid_: board process, backend

**Board page**:
The board's web UI, shown in the board app or in a browser.
_Avoid_: frontend, board UI

**Sample board**:
A board server started with `pnpm run sample` on a spare port, reading `packages/shared/test/sample.json` instead of GitHub.
_Avoid_: test board, dev board

**Board app**:
The installable desktop app that runs the board and updates itself from Releases.
_Avoid_: Electron app, desktop board, dashboard

**Notification**:
A message the board app shows in the stack in its bottom-right corner: a toast for
something that just happened, or a warning for a lasting condition, which stays
until the condition clears or the User closes it.
_Avoid_: toast (for both kinds), banner, notice

**Install overview**:
The notification in the board app's bottom-right corner that shows lar's skills installing into each install target at first launch and after each new Release, with each target's result, Drift it replaced and any Clash.
_Avoid_: install modal, install dialog

**Loading screen**:
The screen the board app and the board page show until the first read settles or a repository's items land, at launch and after a board server restart. The board then fills in as each other repository's read lands. It shows the Lar Factory lockup, whose L draws itself, over one line naming the current step, then fades into the board.
_Avoid_: splash, spinner, starting page

**First read**:
The board server's first read of every repository after it starts. It settles when the read finishes, fails, or the provider's tool blocks it.
_Avoid_: initial load, first sync

**Title bar**:
The bar at the top of the board, in the board app and in a browser. It holds the brand, the scope and the Refreshed time on the left, then the counters, the List button, Add item, the Update button and Settings on the right.
_Avoid_: toolbar, top bar

**List modal**:
The modal the title bar's List button opens, showing the items in List: repositories on the left, the chosen group's items on the right.
_Avoid_: sidebar, list panel, drawer

**Provider**:
The service that hosts a repository and its tickets: GitHub or Azure DevOps. A thread's agent runs on a Provider instance instead.
_Avoid_: platform, board provider, host

**Item source**:
Where the board finds one repository's tickets: the repository's GitHub issues or an Azure DevOps team's backlog and current sprint together. It supplies the tickets the user can pick and their context.
_Avoid_: list source, board source, project

**Azure board**:
An Azure DevOps team's open backlog and current sprint together, with each work item shown once. It keeps completed sprint work and reads the backlog alone when no sprint is current.

**Scope**:
The repository the board shows, picked in the title bar or the List modal, or all repositories.
_Avoid_: project, filter, platform

**Desk**:
The row of items only the user can move on: Ready, Needs you, Verify and Ready to merge. Each card has the button for its next action.
_Avoid_: inbox, queue

**Line**:
The board's view of the work moving through the factory: the Queue, the dossiers, and everything else in flight on one stage track.

**Dossier**:
A concept, or other work with parts, shown on the line. Collapsed, it is two lines of progress and what's next. Expanded, it shows what needs the user, what is blocked or ready, the remaining fog of its map, its threads, and its Work map or parts list. The full map is in its item dialog.
_Avoid_: concept card

**Work map**:
A dossier's diagram of its parts: one lane per repository plus a Decisions lane, columns in dependency order, and arrows for what waits on what.
_Avoid_: map (that is the concept's written account), graph

**Item dialog**:
The board page's view of one item: its work record's brief, map or decision, with its ticket's description, comments, people, labels, dates, relations and linked PRs as context. The description is the one thing the user can edit there.
_Avoid_: detail modal, issue view, ticket view

**Refining**:
The line's first stage, covering Shaping and Needs you. Start refining starts an item's shaping thread.
_Avoid_: shaping (for the stage)

**Start build**:
The board action that starts a Ready build's thread in its own worktree.
_Avoid_: launch

**Start after**:
Arming a blocked part's start, so the board starts it once the local facts in its work records complete every work it waits on and the user has marked each Dependency it needs met. A ticket closing, a Status or a finished T3 turn completes none.
_Avoid_: auto-start (for this)

**Design system**:
The package that holds every token, style and base component of the board page and the board app's loading screen, copied from lar-server's design system; nothing outside it sets its own colours or spacing.
_Avoid_: UI kit, component library, theme

### Upstream files

**Copy**:
A file taken unchanged from an upstream source into one of lar's skills or the design system, and recorded in its folder's record; it changes only through a fresh copy from upstream.
_Avoid_: vendored file, dependency

**Override**:
A lar rule, written in the lar file that loads a Copy, that sets aside part of the Copy's instructions.
_Avoid_: patch, tweak, local change

**Port**:
A file adapted from upstream code or skill text that names its source at the top and follows upstream up to the commit it was last reviewed against; we edit it freely.
_Avoid_: copy, vendored file

### Skills

**Checklist**:
A Copy of a review checklist inside `lar-build`, loaded by the review that needs it.
_Avoid_: reference, reference file

**Provider instance**:
One agent setup T3 Code can run threads on, with its own driver, home and settings, such as a second Claude login. Lar's skills install into each one.
_Avoid_: Claude profile, agent instance, config dir

**Install target**:
A folder where the board app installs lar's skills. Several provider instances can read the same target; T3 supplies targets and the User can select additional ones in Settings.
_Avoid_: agent folder, profile target

**Drift**:
A lar skill in an agent that no longer matches the Release that installed it, because the User edited or deleted it.
_Avoid_: tampered skill, modified skill

### Releases

**Release**:
A published version of the board app, made by CI from a commit on main whose checks passed.
_Avoid_: build, version

**Nightly**:
A Release marked as a prerelease, which the maintainer publishes by hand from main's head once its checks pass; the name comes from T3 Code.
_Avoid_: nightly build, preview

**Stable Release**:
A Release the maintainer publishes by hand from the latest Nightly's commit, which the app's latest channel follows.
_Avoid_: production release
