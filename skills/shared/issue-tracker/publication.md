# Publish finished refinement

Offer publication once refinement finishes, and later when the user asks.
Keep Ready, publication and Start build as separate choices. A build needs a
current passing gate. A concept needs every decision settled in its map, its
Fog recorded gone and every active build's current brief passed. Use
`lar-work publication-readiness <work ID>` to check. Decisions and slices stay
private. Publication never picks tickets, starts builds or imports provider
edits into private work.

## Preview and approval

Use `lar-work` with the board open or closed. The command and board share the
publication engine, effective repository settings and one outcome journal.
Read `lar-work --help` for the input fields and flags. Use these steps for
initial publication and later updates:

1. Read the work, brief, confirmed decisions and current gate. Write a deliberate
   team-language document for each build and, when publishing a concept, its
   destination and decision gists. Include outcome, change, completion checks,
   confirmed assumptions, decisions with reasons, implementation notes, domain
   notes and ordinary related ticket URLs. Keep private maps, work IDs, Status
   and shaping or build progress in records. For each Dependency the
   published work holds, write a request too; see
   [Dependency requests](#dependency-requests).
2. Save JSON with `documents` and run
   `lar-work prepare-publication <work ID> --file <request.json>`.
   Each document has `workId`, `title`, `outcome`, `change`, `checks`,
   `assumptions`, `decisions` with `decision` and `reason`, `builderNotes`,
   `domainNotes` and `relatedTickets`. Every list is required and may be empty.
   Resolve conflicting types explicitly with `typeSelections[workId]`, with
   `null` choosing none where the provider permits it. The command reads fresh
   effective mappings and consent. It writes only an immutable journal plan.
3. Run `lar-work inspect-publication <work ID> --plan <plan ID>`. Show the
   user the exact title and text, destination, mapped type and labels or tags,
   and every operation in order, including native links, update notices and
   before-and-after text. Creation, body edits, comments, mapped terms and
   relationships each require their own consent. Ask for approval of this
   exact plan. An earlier general write preference does not approve its digest.
4. After their approval, record it with
   `lar-work approve-publication <work ID> --plan <plan ID> --revision N --digest <inspected digest> --identity <approver>`.
   Use the inspected plan revision, which is separate from the work revision.
   Reinspect if either changed. Then run
   `lar-work execute-publication <work ID> --plan <plan ID> --identity <executor>`.
   The engine checks sources and settings before each outstanding write,
   claims it as uncertain before dispatch and records its outcome before the
   next write. Report successes, refusals and uncertainty separately.

Any change to the brief needs a new gate. Changes to source text, destination,
mapping or required operations need a replacement plan with `replaces` naming
the current plan and a new exact approval. Retain recorded successes and URLs.
Cancellation leaves the private work available.

## Existing tickets and teammate edits

The default delivery appends a refined description to a picked ticket while
preserving the author's raw text. Later publications replace only the unique,
exact stored publication boundary or comment. Assigned tickets and tickets
with a linked PR also preview a short update comment. It needs comment consent.

On `publication-conflict`, show `stored`, `current`, `proposed` and `location`
from the command's structured error. Ask the user which text to retain and
where the replacement belongs. Prepare a replacement with
`resolutions[workId] = { observedText, location, expectedText }` using the
complete raw text they saw and their explicit selected range or comment ID.
An empty body range explicitly appends after removed content. A missing
comment needs a new-comment or handover choice. Recheck and obtain a new
digest approval. A teammate's edit never grants permission to overwrite it.

Azure HTML, colours, tables and Repro Steps stay raw. The engine preserves the
field and format and uses a revision guard. GitHub body and comment edits and
Azure comment edits have no atomic revision guard. Rereads and verification
can detect a change but cannot guarantee protection against a racing edit.
Offer a new comment or handover when the user needs to avoid that risk.

For deliberate new comments or read-only delivery, put
`delivery[workId] = "comment"` or `"handover"` in the request. Handover needs no
provider write consent or content read. `lar-work publication-handover <work ID> --plan <plan ID>`
prints the approved projection for manual posting. Once posted, attach its
ordinary ticket URL with
`lar-work attach-publication-url <work ID> --revision N --plan <plan ID> --ticket <reference> --url <URL>`.
This preserves the record's identity, brief and Status. A comment URL may
include its query or fragment.

## Resume, reconcile and fallback

Inspect the recorded plan after interruption. Use
`lar-work resume-publication <work ID> --plan <plan ID> --identity <executor>`
for approved pending operations. It skips successes and stops at refusal or
uncertainty. A lost response never means the write failed.

For uncertainty, run
`lar-work reconcile-publication <work ID> --plan <plan ID> --identity <approver>`.
Inspect candidates before selecting one through `--file` containing
`[{"operationId":"...","ticket":"..."}]` or a `commentId`. Native links
can confirm directly. Empty, ambiguous or refused reads leave uncertainty.
If provider evidence shows the write did not complete, ask the user before
recording a failed resolution with `resolve-publication-outcome`, its current
plan revision, operation ID, identity and `{status, evidence}` JSON. Ask before
retrying, then prepare and approve a replacement. Never repeat a successful
write or retry uncertainty.

After body or native relationship refusal, ask whether to preview a comment
fallback. Run `lar-work fallback-publication <work ID> --plan <plan ID>`.
After comment refusal, it previews a handover. For text operations `--file`
may choose `{"delivery":"comment"}` or `{"delivery":"handover"}`. Show the
new plan and ask for its separate approval before writing. A body or native
relationship approval does not approve a fallback comment. Read-only handover
remains available when writes are refused.

## Dependency requests

A Dependency's request asks the owning team for the change. List it under
`dependencies` in the prepare request with `dependencyId`, `title`, `change`,
`reason`, `contract` and `checks`, in team language. `lar-work dependencies <work ID>`
prints the work's Dependencies. The engine adds a link to each of the user's
published tickets the Dependency blocks, and uses the owning repository's
Vocabulary when it is onboarded and plain terms otherwise.

- With no ticket yet, the plan creates the request in the owner's repository.
  An owner named as a team rather than a repository gets a handover.
- With a ticket the team already has, the plan posts the request as a comment
  only when `delivery[dependencyId]` is `"comment"`; otherwise it is a handover.
- A repository that is not onboarded has no saved consent, so tell the user
  that approving the exact plan is the only permission for that write.
- After the request reaches the team's ticket, the engine records the ticket on
  the Dependency and never writes to that ticket again. A correction is a new
  plan whose request shows in `publication-handover` for the user to send.
- Each build the Dependency blocks gets a native blocked-by link to the team's
  ticket. After a refusal, `fallback-publication` previews a `Depends on <URL>`
  comment on the user's ticket; after that is refused, a handover. A refusal
  never changes the private blocker or the Dependency's handover.

If the login cannot write to the owner's repository, choose the handover
fallback and give the user its text to send.

## Delivery PRs

Read [PR delivery](publication-pr.md) when opening a build's PR, including a
ticketless build. A concept's parent ticket stays separate from each build's
closing target. The recorded PR merging still drives local Done even when
the provider closes its ticket separately.
