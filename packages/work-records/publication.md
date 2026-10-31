# Publication engine

The board server and installed command use `@lar-factory/work-records/publication`.
Browser code uses only `@lar-factory/shared/publication`. The existing work-record
journal owns all durable state; publication never changes Status or starts a build.

`publicationEngine(records, { dir?, settings?, allowed?, provider? })` returns the async
methods below. `allowed` says which repositories are on this Mac's list, and defaults to
the saved list.

- `prepare(workId, request)` records an immutable, unapproved plan.
- `inspect(workId, planId)` checks sources and fresh effective settings.
- `execute(workId, planId, identity)` and `resume(...)` dispatch outstanding writes.
- `fallback(workId, planId, delivery?)` previews comments after body or native-link refusal, or a handover after comment refusal.
- `reconcile(workId, planId, identity, selections?)` inspects uncertain outcomes.

`PreparePublication` contains `documents`, optional `typeSelections` indexed by work
ID, optional `replaces`, `delivery` and `resolutions`. Each document names `workId`,
`title`, `outcome`,
`change`, `checks`, `assumptions`, `decisions` with `decision` and `reason`,
`builderNotes`, `domainNotes` and `relatedTickets` containing URLs. Lists are required
and may be empty when nothing applies. The caller writes these team-language
projections from the refinement for review. The engine renders concept destination
and decision gists and complete build content; it never copies private maps or
rewrites arbitrary private prose. Decisions contribute evidence but never tickets.
Slices never publish.

Settings come from `readPublicationSettings(repo, options?)` in
`@lar-factory/shared/publication-settings`, returning `{ setup, discovery, snapshot }`.
Each ticket records its effective settings snapshot. Structural `build` and `issue`
records have no kind mapping; `resolveVocabulary` accepts `undefined` for that kind.
Conflicting exclusive types require a choice before preview; `null` chooses none.
Creation, later body edits, comments, types, terms and native relationships keep
separate consents. Initial body content belongs to creation consent; later body
changes require `edit-ticket`. Saved credential refusal blocks that operation.

Approve with the journal's
`approvePublication(workId, planId, revision, digest, identity)`, echoing the inspected
digest. Sources and settings are checked before every outstanding write. A
replacement may refresh settings evidence and retain completed creations, including
URLs already attached by the board. Their provider payloads stay exact; changing
published text uses a new existing-ticket update operation.

Operations run parent creation, build creations, then native relationships.
`ticketWorkId` is the child or dependent; `relatedWorkId` is its parent or blocker.
References come from recorded receipts. Only local relationships within the plan
publish here; Connections and external Dependencies remain outside this build.

Claims become uncertain atomically before dispatch. Each provider result persists
before the next operation. Failure or uncertainty stops dispatch, retains successes
and reports each outcome separately. No method rolls back success or retries a
write automatically. Creation recovery searches by approved title, destination and
claim time, then inspects full content and terms. Comments are paginated and checked
against exact text. Candidates need explicit user selection with
`{ operationId, ticket }` or `{ operationId, commentId }`. A confirmed native link can
resolve directly. Empty or ambiguous evidence leaves uncertainty. A user can declare
that an uncertain write did not complete through `resolve-publication-outcome`,
with identity and inspected provider evidence. Every retry needs a replacement and
new approval.

The CLI exposes `prepare-publication`, `inspect-publication`, `approve-publication`,
`execute-publication`, `reconcile-publication`, `resume-publication` and
`fallback-publication`; `--help` describes JSON inputs. `--data-dir` selects the
journal and settings. `publication-handover` prints the same content for manual
posting. Preview and cancellation leave private work available.

## Provider limits

`@lar-factory/work-records/publication-providers` exports `PublicationProvider` and
`publicationProvider(transport?)`. Both the command and board use these adapters.
The default transport shares `@lar-factory/shared/provider-command` with Vocabulary
discovery and uses the local `gh` and `az` logins. It never retries a request or
writes credentials, factory markers, assignees, priority, iteration, State, board
changes or repository tags.

GitHub uses approved title, body, mapped labels and selected type. Relationships use
the [sub-issue](https://docs.github.com/en/rest/issues/sub-issues) and
[dependency](https://docs.github.com/en/rest/issues/issue-dependencies) endpoints.
Unavailable endpoints and permission refusals need approved textual fallback; 404
alone does not establish that a capability is absent.

Azure requires a mapped work item type, and tags cannot contain semicolons. New
bodies use [Markdown's multilineFieldsFormat setting](https://devblogs.microsoft.com/devops/markdown-support-arrives-for-work-items/).
Creation, reads and comments use `az devops invoke`. Only revision-checked work-item
body and link PATCH use `az rest`, following
[ADR 0029](../../docs/adr/0029-azure-calls-go-through-az-devops-invoke-and-only-a-work-item-patch-through-az-rest.md).
That PATCH still depends on az login's default tenant; another-tenant organizations
may refuse links despite successful reads and creation. Preview versions use bare
`-preview` because invoke appends the server resource version. WIQL refusal or result
limits leave uncertainty. Cross-provider and cross-organization native links need
textual fallback.

## Existing tickets and updates

A picked ticket or a known publication receipt selects an existing destination.
`prepare` appends a marked refined description below the original raw body.
Markdown uses neutral `refined-description` delimiters. HTML uses visible opening
and closing labels with escaped refinement text. Neither contains a factory ID.
The normal description editor is never involved.

The journal records the exact published text and body offsets or comment ID.
Azure body locations also record `field`, either `System.Description` or
`Microsoft.VSTS.TCM.ReproSteps`. Initial field selection follows the board's Bug
and Repro Steps behavior. Later updates keep the recorded field even if a teammate
adds another description field. HTML colours, merged cells and existing raw content
remain unchanged in the outgoing patch. The patch changes only that field, with a
`/rev` test. It never switches an existing field to Markdown.

`PreparePublication.delivery` maps work IDs to `body`, `comment` or `handover`.
The default `body` updates the last primary publication location, including a prior
comment fallback. `comment` deliberately plans a new Markdown comment on an existing
ticket. `handover` creates no operations for that record and needs no provider
content read or write consent. Settings and readiness still apply. The handover is
available through `publication-handover`, even with write access refused.
`attach-publication-url` attaches its eventual ordinary ticket to the same record
without replacing its brief, Status or identity. A manually posted comment URL
on the same ticket page may include its query or fragment.

Every update operation previews `expectedText` and `content` as the before and
after diff. Body operations also include the complete raw `expected` snapshot with
format, field, revision when available, assignment and linked-PR facts. The engine
locates only unique exact stored text. Edited, missing or ambiguous boundaries
throw `PublicationConflict` with `.conflict` containing `workId`, `stored`, `current`,
`proposed`, `location` and `reason`. No plan is recorded on that conflict.
`inspect` reports a later provider conflict in `PublicationPending.conflicts` and
makes the plan noncurrent.

After asking the user to resolve it, pass
`resolutions[workId] = { observedText, location, expectedText }` to `prepare` with
`replaces`. `observedText` is the complete raw description or comment the user saw.
`location` is their explicit replacement range or the same comment ID.
`expectedText` is the exact selected text. An empty body range explicitly appends
after removed content. The provider is reread and must still match the resolution.
The resulting plan requires approval of its new digest. A missing comment needs
an explicit new-comment or handover choice.

Assigned tickets and tickets with a linked PR get an additional short update
comment for a body write. Its exact text and dependency are in the same approval.
Unassigned tickets without a linked PR get no notice. Notices retain their own
operation outcomes but never replace the primary published text in `lastPublished`.
`PublishedText.operationKind` distinguishes primary text from relationship comments,
including when the owning plan belongs to a concept. Updates do not repeat
relationships already recorded as successful in earlier plans.

`edit-ticket` and `comment-ticket` keep separate consent and access checks.
`fallback` defaults body edits to a comment and comments to a handover. Its optional
third argument chooses `comment` or `handover` for outstanding text operations.
The CLI accepts that choice as `--file F` containing `{ "delivery": "handover" }`
or `{ "delivery": "comment" }`. It produces a new unapproved immutable plan and
retains successful operations. An earlier body approval never approves a fallback
comment. Unsupported format refusal includes exact Markdown comment and handover
alternatives. The CLI writes structured `publication-conflict` or
`publication-refused` JSON to stderr and exits 1 when preparation needs a choice.

The adapters reread immediately before writes and verify stored text after accepted
writes. A lost response, failed verification read or normalized raw text remains
uncertain. Reconciliation confirms body writes only when the complete raw body,
format and approved location match. Comments require exact content and explicit
candidate selection, and replacements also require the original comment ID.
Empty or conflicting evidence permits no automatic retry. Resolve the old outcome,
then prepare and approve a replacement before retrying.

### Concurrency limits

[Azure work-item updates](https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/work-items/update?view=azure-devops-rest-7.1)
provide the revision test used for raw body edits. The same default-tenant limitation
as native-link PATCH applies. GitHub's
[issue update](https://docs.github.com/en/rest/issues/issues#update-an-issue) and
[comment update](https://docs.github.com/en/rest/issues/comments#update-an-issue-comment),
and [Azure comment update](https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/comments/update-comment?view=azure-devops-rest-7.1),
document no atomic revision precondition for these edits. Their reread and PATCH
can race a teammate edit. Post-write verification detects a differing stored result
but cannot recover overwritten text or guarantee an atomic update. Choose a new
comment or handover when that limit is unacceptable. A failed timeline or comment
read cannot establish that a PR or publication is absent.

Controlled-client tests cover both providers, including picked append, exact
replacement, HTML and Repro Steps preservation, conflicts, notices, refusals,
handovers, URL attachment and restart after lost body and comment responses.
No live tracker writes were used. Connections and external Dependencies remain
outside this build.

## Delivery PR relationships

`@lar-factory/work-records/publication-pr` exports `publicationPr(records,
{ dir?, settings?, transport? })`. `body(workId, markdown)` returns the complete
body plus `Closes <repository#number>` for GitHub. Ticketless and Azure bodies
retain the complete outcome and reasons. Target lookup uses this build's
picked ticket, publication attachment or primary published receipt, including
receipts from a concept-owned plan. It never selects the concept's parent.

After recording the PR, `prepare(workId)` previews its relationship in the
existing journal as `pr-closing-reference`. GitHub verifies the closing line
already delivered in the reviewed PR body and requires the default branch.
Azure links the work item to the PR with
[`az repos pr work-item add`](https://learn.microsoft.com/en-us/cli/azure/repos/pr/work-item?view=azure-cli-latest).
It leaves native completion options unchanged. The team's
[PR completion setting](https://learn.microsoft.com/en-us/azure/devops/repos/git/complete-pull-requests?view=azure-devops)
decides whether the linked work item transitions when the user merges. No
State write or completion-option update is part of this command. GitHub's
[closing-reference contract](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue)
controls its ticket closure.

`inspect`, `execute` and `reconcile` use the same immutable approvals, source
checks, settings snapshots, claims and outcome commands as publication.
Azure needs separate `relate-ticket` consent. Execute checks existing native
links before adding one. A refusal records failure; a lost response or failed
verification remains uncertain. Reconciliation confirms the relationship or
keeps uncertainty for explicit user resolution. Retry needs a replacement and
new approval. Repeated execution resumes pending work only.

The installed command exposes `publication-pr-body`, `prepare-publication-pr`,
`inspect-publication-pr`, `execute-publication-pr` and
`reconcile-publication-pr`. Use ordinary `approve-publication` and outcome
commands with their returned plans. No additional receipt store exists.
Controlled tests cover both native completion settings, refusal, lost-response
recovery, GitHub body generation and ticketless completeness. Local completion
still comes from the recorded PR's merge observation.

## Board interface

The board routes all publication requests through guarded POST endpoints under
`/api/publication/`. Every request includes `workId` and the current board `session`.
`open` reconstructs `PublicationBoardState` from the journal, with eligibility,
private source text for reference, fresh destination settings and the latest plan.
It also attaches confirmed creation receipts that survived an interrupted board
request. Neither opening nor cancelling dispatches a provider write.

`prepare` accepts the engine's document, type-selection, delivery and resolution
fields plus `sources`, every readiness source's work ID and displayed revision.
It refuses stale source revisions before preparing. The shared browser-safe
`PublicationDocument` type is also re-exported by the engine entry. The shared
`publicationConsents` function names the independent permissions for an operation.

`approve` and `resume` require the stored `planId`, `revision` and `digest`.
`inspect`, `fallback` and `reconcile` require `planId`. Fallback accepts optional
`delivery`; reconciliation accepts explicit `selections`. Every result returns a
fresh board publication state. An approval conflict may return that state with
an `error` and HTTP 409. Text conflicts during preparation return the engine's
`conflict` with stored, current and proposed text. Requests for the same root work
are rejected while another request runs. The journal also guards claims shared
with commands and other publications.

A stored delivery PR plan uses the existing `publicationPr` engine for inspection,
execution and reconciliation. It keeps the same board approval identity checks.

The board mounts one `PublicationDialog`. Later append, update and recovery
screens can open it through `usePublicationStore.open(workId)` and submit engine
request fields through `request(action, extra)`. `request('prepare', ...)` returns
to exact preview; it never approves automatically. Browser documents are temporary
editing drafts. Every reopen reconstructs plans and outcomes from the server.
Controlled HTTP tests cover GitHub and Azure destinations with injected provider
responses. They do not verify real credentials or provider availability.

### Board recovery and handover

The dialog separates the original raw description, the exact refined addition and
its replacement range. A later preview shows the exact recorded before text and
the proposed after text. Teammate conflicts show the stored, current and proposed
versions. Select offsets in the current raw text, replace the recorded comment,
keep the current text and append, or choose a new comment or handover. The engine
rereads the resolution before recording a fresh unapproved plan.

Delivery choices in the content editor include body, new comment and handover.
Fallback buttons also return to an unapproved preview. Failed operations can use
`retry`, which copies their exact operations into a replacement while retaining
successful receipts. Approval still binds the replacement's ID, revision and
digest. Changed sources or settings require a fresh content preview instead.
The dialog keeps earlier outcomes visible and drops stale item-details caches
after confirmed publication.

`reconcile-url` accepts an ordinary URL in the approved GitHub repository or Azure
project. It passes the resolved reference to shared-engine reconciliation. The
engine searches first and inspects the supplied ticket even if search is refused.
The title, full body and mapped terms must match the approved creation. An empty
search never authorizes retry. `resolve-outcome` requires the user's explicit
confirmation and inspection evidence, rereads provider evidence and records failure
before a separately approved retry can be prepared. A lost HTTP response blocks
another submission until the board reads the journal.

The complete handover can be copied or downloaded without write permission. It
includes team content and local relationships between its tickets. After manual
posting, `resolve-url` reads the destination for inspection. `attach-url` requires
the inspected work revision and uses `attachPublicationUrl`, preserving the same
work ID and publication provenance. These actions never fetch an arbitrary host
from user input. They use the existing provider adapter and approved destination.
All added routes retain the board secret, origin, session and sample-mode guards.

### User verification

Use controlled provider fixtures or disposable tickets for these checks. Automated
board route and dialog tests use controlled responses. They do not establish live
permissions, provider availability or the rendered layout on a real display.

1. Open Publish on a Ready build. Enter team-language content, review its exact
   destination, title, text, type and terms, then cancel. Refinement and Start build
   must remain available. On a new preview, approval must name the stored plan and
   dispatch each remaining operation only once.
2. On a picked Azure HTML ticket with coloured text and merged cells, inspect the
   original description separately from the escaped addition. Choose new comment
   or handover before writing. A body preview must retain HTML and the recorded
   Azure field. It must show the revision and default-tenant limits.
3. Publish an update, then edit its refined text as a teammate. Reopen Publish and
   compare the stored, current and proposed text. Select only the replacement
   range, prepare again and approve the new preview. Unrelated text must survive.
4. Refuse a native relationship or body edit. Inspect the short cost line and the
   exact fallback comment or textual relationship. Its preview must require its
   own approval. Refused comments must still permit a complete markdown handover.
5. Use read-only access to copy or download the handover. After posting, enter its
   ordinary ticket URL, inspect the resolved destination and attach it. The work's
   brief, Status and ID must remain the same.
6. Lose a creation response and restart. Completed, failed and uncertain outcomes
   must remain separate. Inspect provider candidates or supply the existing URL.
   Select the matching ticket explicitly. If inspection establishes no completed
   write, record that conclusion and prepare a retry. Completed operations must
   stay visible and must not run again.
7. Use the keyboard to reach choices, inspect links and cancel with Escape. Focus
   must return to Publish. While a request runs, approval and cancellation must
   remain disabled. Sample mode must offer no publication writes.
