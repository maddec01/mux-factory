# Work records

Factory work lives in work records on the user's machine. A record holds the
work's title, Status, structure, brief, map, decisions, threads and PR. Steps
read and write records only through `lar-work` and the shared scripts.
`lar-work --help` lists the commands and what each prints. Every change takes
the `--revision` from your last read; when the record moved on, the change
writes nothing, so read it again and redo the change.

Factory progress stays on this machine. No step edits a ticket's body,
comments, labels, tags or Azure State to record shaping, Status or
build progress.

## Picking

A **work ID** names one record for its whole life. Work reaches the board when
the user captures it there or picks a ticket there: a GitHub issue, or an Azure
DevOps work item. A picked ticket's record keeps the ticket reference, and the
ticket's text at pick time is the record's initial context
(`lar-work context <work ID>`). That text is where shaping starts. Refinement in
the record is the authority, and a later ticket edit never changes it.

Resolve a thread's argument, a work ID or a ticket (`owner/repo#12`, its issue
URL, or an Azure work item URL), with
`bash <this skill>/shared/scripts/work.sh <ref>`, which prints the record. For
a ticket no record holds, it fails with "Pick the ticket on the board, then
rerun". Pass that on to the user and stop. Records come from the board's
capture and pick, so a thread never creates one for a ticket.

Name the work ID in every handoff, delegated-task brief and thread message.

## Status

The statuses are List, Queued, Shaping, Needs you, Ready, In progress, Review,
Verify, Ready to merge and Done. Move work with
`bash <this skill>/shared/scripts/status.sh <work ID> "<Status>"` as the
workflow directs. It writes only the record, then asks a running board to read
it. It refuses Done, which completion decides, and a PR, which has no Status.

## Structure

A concept owns decisions and builds, and a build owns slices. Create owned work
with
`bash <this skill>/shared/scripts/slice.sh <parent> "<title>" <body-file> [--kind decision|build] [--blocked-by <work>]...`.
It prints the new work ID; keep it. Under a concept, `--kind` names a decision
or a build; under a build the record is a slice. Record a later blocker with
`lar-work add-blocker <work ID> --revision N --blocker <work ID>`, and drop one
with `remove-blocker`. `children`, `blockers` and `dependents` read the
structure.

Owned work takes its parent's repository unless it is a build in another
repository, as [Other repositories](#other-repositories) routes it.

## Other repositories

Route each part of the work that another repository needs by that repository.
`bash <this skill>/shared/scripts/repo-config.sh --list` lists the onboarded
repositories, and `repo-config.sh --connections <owner/repo>` prints the ones
connected to this one.

- An onboarded repository is one the user can change. A Connection grants no
  permission to act. When the work needs a change in a connected onboarded
  repository, propose a build there and wait for the user's OK before planning
  it. Then make it with
  `lar-work create --title X --repository <owner/repo> --kind build`, put it
  under the concept with `lar-work set-parent` or record the wait with
  `lar-work add-blocker`, and shape it in that repository. An onboarded
  repository that isn't connected comes into play only when the user names it.
- In a repository that is not onboarded, read code, docs and tickets for
  context and write nothing there. When required work is there, keep refining
  and offer the user both choices: onboard it to plan a build, or record a
  Dependency for the team that owns it. Onboard or change a repository only on
  the user's choice.
- When the login cannot push a branch or deliver a fork PR to a repository,
  explain the block to the user and offer a Dependency.

Record a Dependency on the work that needs it with
`lar-work add-dependency <work ID> --file <file>`. The JSON's `need` says what
is needed and why, and `owner` names the owning repository or team;
`lar-work --help` lists the optional fields. It prints the Dependency ID. Hold
each build that waits on it with
`lar-work add-dependency-block <Dependency ID> --revision N --build <work ID>`.
Send its request to the owning team per
[Dependency requests](publication.md#dependency-requests).

A Dependency is met only when the user marks it met
(`lar-work mark-met <Dependency ID> --revision N --identity <user>`). A closed
ticket proves neither deployment nor the contract. After the handover, read
that team's ticket and PRs to follow the work, and leave the ticket as the team
keeps it: never edit, assign, move or close it.

Onboarding the repository later keeps its Dependencies. Replacing one with a
build is the user's choice and needs their approval of the plan. Once they
approve, make the build as above and run
`lar-work replace-dependency <Dependency ID> --revision N --build <work ID>`.

## Completion

Completion comes from the records. `lar-work completion <work ID>` prints
whether work is complete and why not; `lar-work waiting-on <work ID>` prints its
blockers that aren't complete. A build is complete once its recorded PR merges.
A decision is complete once its answer and domain drafts are recorded and its
concept's map is written after them. A concept is complete once its Fog is
recorded gone (`lar-work set-fog`) and every decision and build it owns is
complete. A Status, a closed ticket or an ended thread completes nothing, and no
step changes Azure State to complete publication work. A delivery PR uses the
provider's closing relationship independently of local completion.

## Publication

Offer publication of finished refinement and handle later publication requests
through [publication](publication.md). It uses the common command and journal
with the board closed. Ready and Start build remain separate choices. Publish
only concepts and builds, with team terms and exact approval. Decisions,
slices and progress stay in records. Opening a build's PR follows
[PR delivery](publication-pr.md), including ticketless work.

## Providers

A repository's provider is its origin's host. Read GitHub tickets with the
local `gh` login, and Azure DevOps work items per
[Azure DevOps](azure-devops.md#azure-devops). A failed read leaves the record
as it was.
