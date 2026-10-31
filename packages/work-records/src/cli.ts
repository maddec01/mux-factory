#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// lar-work: reads and changes work records by opening the work-record database directly, so shaping and build threads
// use it from any folder while the board app is closed. It prints each result as JSON on stdout, a body as its markdown,
// and each error as one line on stderr.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { isRecord } from '@lar-factory/shared';
import type { PublicationContent, PublicationOutcome, PublicationProposal, Status } from '@lar-factory/shared';
import { exportMarkdown } from './export.ts';
import { PublicationRefused } from './publication-providers.ts';
import { PublicationConflict, publicationEngine, type PreparePublication, type ReconciliationSelection } from './publication-engine.ts';
import { publicationPr } from './publication-pr.ts';
import {
  openWorkRecords, readRetention, WorkRecordError, workRecordsPath, writeRetention, type Body, type BuildPhase, type FindingDisposition,
  type DependencyChange, type DependencyObservationKind, type NewDependency, type NewObservation, type NewReviewRound, type Observed,
  type ReviewAxis, type WorkKind, type WorkRecords,
} from './work-records.ts';

const HELP = `Usage: lar-work <command> [options]

Reads and changes the factory's work records in the work-record database, which
it opens directly. It works from any folder, with or without the board app.

Identifiers
  A work ID names one work record for its whole life. create and import print it.
  A ticket is a published ticket reference, owner/name#12. A record holds at most
  one, and attaching it keeps the work ID.
  A repository is the repository's name on the board, owner/name.

Reads
  read <work-id>                    Print one record.
  context <work-id>                 Print the markdown the record began with.
  list [--repository R] [--status S] [--kind K]
                                    Print matching records, Queued ones in Queue order.

Changes
  Each change except create and import needs --revision, the revision you last
  read. When the record has moved on, the change fails and nothing is written.
  create --title X --repository R --kind K [--status S] [--ticket T] [--file F]
                                    Make a record titled X, a single line, with the
                                    markdown in F as its initial context. Status
                                    defaults to List.
  import --title X --repository R --kind K --ticket T [--status S] [--file F]
                                    Print the record holding T, making it first if
                                    none does. Repeating it never makes a second one
                                    and never changes the title or initial context.
  update <work-id> --revision N [--status S] [--kind K]
  attach-ticket <work-id> --revision N --ticket T
  set-aside <work-id> --revision N  Set the record aside. Its Status stays.
  restore <work-id> --revision N    Bring a set-aside record back.
  set-needs-you <work-id> --revision N --reason X
                                    Record why the work waits on you, such as a
                                    closed unmerged PR. Its Status stays.
  clear-needs-you <work-id> --revision N
  snapshot-skills <work-id> --revision N [--skill S]...
                                    Record the project skills selected as the build
                                    starts; give none for an empty selection. A
                                    build snapshots once, so later selections
                                    change only future builds.

Structure
  A concept owns decisions and builds, and a build owns slices. A record has at
  most one parent. A blocker is a record the work waits on; a record can't block
  itself or close a cycle. Each change bumps the revision of both records.
  set-parent <work-id> --revision N --parent P
                                    Put the record under P. Clear an old parent first.
  clear-parent <work-id> --revision N
  add-blocker <work-id> --revision N --blocker B
                                    Record that the work waits on B.
  remove-blocker <work-id> --revision N --blocker B
  children <work-id>                Print the records it owns.
  blockers <work-id>                Print the records it waits on, then the unmet
                                    Dependencies holding it.
  dependents <work-id>              Print the records that wait on it.

Completion
  Completion comes from the records alone; a Status, a ticket closing or a
  thread ending never completes work. A build, or any other record that becomes
  a PR, completes once its recorded PR is observed merged. A slice completes once
  it is finished. A decision completes once its answer and domain drafts are
  recorded and its concept's map is written after them. A concept completes once
  its Fog is gone and every decision and build it owns, except set-aside ones, is
  complete, and a build stays incomplete while an unmet Dependency holds it.
  Work can start once each of its blockers is complete and no unmet Dependency
  holds it.
  completion <work-id>              Print whether the record is complete and each
                                    reason it isn't.
  waiting-on <work-id>              Print its blockers that aren't complete, then
                                    the unmet Dependencies holding it, with the
                                    reasons. Work can start once this prints [].
  set-fog <work-id> --revision N --fog gone|remaining
                                    Record whether a concept's Fog is gone.
  finish <work-id> --revision N     Record that a slice merged into its build branch.

Content
  A record keeps its markdown here only; nothing is written to a ticket. A
  concept holds a map; a decision holds its text, its confirmed answer and its
  domain drafts; any other record holds a brief. A --file of - reads standard
  input.
  set-body <work-id> --revision N --body brief|decision|map|answer|domain-drafts
           --file F
                                    Replace the body with the markdown in F.
  body <work-id> --body B           Print the body as markdown.
  set-phase <work-id> --revision N --phase P
                                    P is one of plan, implement, domain-docs,
                                    full-checks, review, approve, checks, retro.
  set-pr <work-id> --revision N --pr owner/name#12
                                    Record the PR the build delivers through. A
                                    record holds one current PR; setting another
                                    keeps the earlier one as history.
  pr-history <work-id>              Print the PRs the record held before its current one.
  record-review-round <work-id> --revision N --file F
                                    Record the build's next review round from the
                                    JSON in F: {"base": sha, "reviewers": [{"axis",
                                    "verdict", "notChecked"?, "findings": [{"severity",
                                    "summary", "disposition", "reason"?}]}]}. Axes are
                                    code, security, ui and performance; verdicts
                                    approve, changes and skipped; severities blocker,
                                    should and nit; dispositions open, fixed and
                                    rejected. A skipped axis or a rejection needs a
                                    reason. A round with any bad part records nothing.
  set-disposition <work-id> --revision N --round R --axis A --finding K
                  --disposition D [--reason X]
                                    Change what became of the axis's Kth finding.
  review-rounds <work-id>           Print the build's review rounds.

Publication
  publication-pr-body <work-id> --file F
                                    Return JSON with the complete Markdown PR body
                                    in F plus this build's GitHub closing reference,
                                    or unchanged text for Azure or ticketless work.
  prepare-publication-pr <work-id>
                                    After set-pr, preview GitHub body verification or
                                    native Azure PR linking for this build's ticket.
                                    Returns null for ticketless work. Replaces the
                                    current plan; resolve uncertainty before retry.
  inspect-publication-pr <work-id> --plan P
  execute-publication-pr <work-id> --plan P --identity I
  reconcile-publication-pr <work-id> --plan P --identity I
                                    Use the same approval and outcome journal. Execute
                                    resumes pending work only. Reconcile uncertain
                                    links before any retry. Azure completion options
                                    and State remain under native team control.
  prepare-publication <work-id> --file F
                                    Prepare an immutable publication preview. F is
                                    PreparePublication JSON: documents, optional
                                    typeSelections, replaces, delivery and resolutions.
                                    delivery maps work IDs to body, comment or handover.
                                    resolutions map work IDs to observedText, location
                                    and expectedText from an explicit user resolution.
                                    Each document names
                                    workId, title, outcome, change, checks, assumptions,
                                    decisions [{decision, reason}], builderNotes,
                                    domainNotes and relatedTickets (HTTP URLs).
                                    Lists may be empty when nothing applies. Use team
                                    language; private bodies are never copied blindly.
                                    Optional dependencies list requests for the teams
                                    that own the work's Dependencies: dependencyId,
                                    title, change, reason, contract and checks. A
                                    request is created on the owner's repository, or
                                    commented on its ticket when delivery says
                                    comment. Once posted, later plans give revised
                                    handover text only. Builds a Dependency blocks
                                    link to its ticket as blocked by it.
  inspect-publication <work-id> --plan P
                                    Recheck sources, settings and pending provider text.
  execute-publication <work-id> --plan P --identity I
  resume-publication <work-id> --plan P --identity I
                                    Dispatch approved outstanding writes through the
                                    same engine as the board; stop on failure or
                                    uncertainty. Skips completed writes. No retries.
  reconcile-publication <work-id> --plan P --identity I [--file F]
                                    Search and inspect uncertain provider outcomes.
                                    Optional F is [{operationId, ticket|commentId}], explicitly
                                    selecting a ticket or comment after inspection.
                                    Empty or ambiguous searches never permit retry.
  fallback-publication <work-id> --plan P [--file F]
                                    Preview comments after body or native link refusal,
                                    or a handover after comment refusal. Optional F
                                    is {delivery: comment|handover} for text operations.
                                    Approve its new digest before executing it.
  gate <work-id>                    Print the current brief digest and gate history.
  record-gate <work-id> --revision N --digest H --identity I --evidence E
                                    Attest that this exact brief passed its gate.
                                    N is the work revision. This writes no Status.
  publication-readiness <work-id>   Print eligibility and all source revisions.
                                    Concepts require settled decisions, no Fog and
                                    current passing briefs, regardless of PR merge.
  propose-publication <work-id> --revision N --file F
                                    Store immutable PublicationProposal JSON. N is
                                    the root work revision. sources lists every
                                    {workId, revision}; tickets gives each destination,
                                    effective vocabulary, explicit typeResolution,
                                    title and body; operations lists ordered writes.
                                    A replacement names replaces, the current plan ID.
                                    Operation kinds are create, append, replace,
                                    comment, replace-comment, relationship,
                                    textual-relationship and pr-closing-reference.
                                    Body offsets count JavaScript UTF-16 code units.
                                    Replacements include exact expectedText and location.
                                    Relationships name an internal relatedWorkId and
                                    child or blocked-by. Closing references name the
                                    work's recorded pullRequest and exact content.
  publication <work-id> --plan P    Print the exact plan, digest, approval and outcomes.
  publications <work-id>            Print all plans, including superseded plans.
  approve-publication <work-id> --plan P --revision N --digest H --identity I
                                    Approve the exact digest printed by inspection.
  pending-publication <work-id> --plan P [--file F]
                                    Print source validity, next operation, successful,
                                    failed and uncertain operation IDs. F is current
                                    PublicationContent JSON with tickets and operations.
  claim-publication <work-id> --plan P --revision N --digest H --identity I --file F
                                    Atomically claim the next operation, returning
                                    plan, operation and claimToken. F must contain
                                    content prepared from current settings and reads.
                                    Claim records uncertainty before provider dispatch.
                                    A crash never returns the operation to pending.
  record-publication-outcome <work-id> --plan P --revision N --operation O
                             --claim C --file F
  resolve-publication-outcome <work-id> --plan P --revision N --operation O
                              --identity I --file F
                                    F holds {status, evidence, ticket?, url?, location?}.
                                    status is successful, failed or uncertain. A success
                                    needs the exact body boundary or comment ID for
                                    text writes. Creation also needs ticket and url.
                                    Resolution requires successful or failed evidence
                                    from reconciliation. Retry needs a new approval.
  record-publication-evidence <work-id> --plan P --revision N --operation O --evidence E
  publication-evidence <work-id> --plan P
  last-published <work-id>          Print exact published texts and their locations.
  publication-handover <work-id> --plan P
                                    Print team-facing markdown for manual posting.
  attach-publication-url <work-id> --revision N --plan P --ticket T --url U
                                    Attach a result or manually posted handover URL.
                                    N is the work revision. Local identity stays.
  publication-attachment <work-id> Print the attached ticket URL and its plan.
  Other publication changes use the plan revision, separate from work revisions.
  They never queue work, start builds, or complete work. --file - reads stdin.
  Empty operations makes a handover-only proposal. Required writes, destinations,
  mapping and exact text are fixed in each plan. Failed work needs a replacement;
  resolve uncertain work before replacing it. Completed results remain recorded.

Provider observations
  An observation is the last read of the record's ticket or current PR from its
  provider, kept with the time it was read. A newer read replaces it. A failed
  read keeps it and records when and why the read failed. An observation never
  changes the record's title, context or refinement. A merged PR finishes the
  work; replacing the PR drops its observation.
  observe <work-id> --revision N --of ticket --state open|closed|not-found
          [--assignee A]
  observe <work-id> --revision N --of pr --state open|merged|closed
                                    Record a successful read. A closed PR is
                                    closed unmerged.
  observe-failure <work-id> --revision N --of ticket|pr --failure F
                                    Record that a read failed with reason F.
  observations <work-id>            Print the ticket's observation, then the PR's.

Dependencies
  A Dependency is a change the work needs in a repository you don't work on,
  delivered by the team that owns it. It lives inside one work record, has its
  own ID and revision, and holds only the builds it blocks, each in the same
  work tree as its record. Each block change bumps the build's revision too.
  Only you decide it is met: observations of its ticket and PRs never set or
  clear the mark, and never delete it or its handover. An observation that
  changes after you marked it met flags it for review and leaves it met; marking
  it met again clears the flag. Retention keeps a record while it holds a
  Dependency or one blocks it. Dependency commands take a Dependency ID.
  add-dependency <work-id> --file F Add a Dependency from the JSON in F: {"need",
                                    "owner", "contract"?, "evidence"?, "ticket"?,
                                    "pullRequests"?: [...], "handover"?}. need says
                                    what is needed and why; owner names the owning
                                    repository or team. Prints its Dependency ID.
  dependencies <work-id>            Print the Dependencies the record holds.
  dependency <dependency-id>        Print one Dependency.
  update-dependency <dependency-id> --revision N --file F
                                    Change the fields in the JSON in F; a null
                                    ticket removes it. Observations of a ticket or
                                    PR it no longer names are dropped.
  add-dependency-block <dependency-id> --revision N --build B
                                    Record that the Dependency holds the build B.
  remove-dependency-block <dependency-id> --revision N --build B
  observe-dependency <dependency-id> --revision N --subject S --state K
                     [--detail X]
                                    Record the latest read of S, its ticket or one
                                    of its PRs. K is open, closed, merged, reopened,
                                    deleted, access-lost or read-failed; X is what
                                    the provider said, such as why a read failed.
                                    A failed read or lost access keeps the last
                                    read that answered beside it.
  mark-met <dependency-id> --revision N --identity I
                                    Record that you, I, decided it is met.
  clear-met <dependency-id> --revision N
  replace-dependency <dependency-id> --revision N --build B
                                    Make every build it holds wait on the build B
                                    instead, all in one change. The Dependency and
                                    its met mark stay. Without this, onboarding its
                                    repository later leaves the Dependency as it is.

Threads and launch intents
  A thread ID is T3's. A launch intent is recorded before the board asks T3 to
  start a thread, and resolved once T3 answers, so a restart finds the start
  instead of making a second one. lar-work never starts or checks a thread.
  A purpose is a lowercase word naming what the thread does, such as build.
  add-thread <work-id> --revision N --thread T --purpose P
  threads <work-id>                 Print the record's threads.
  record-intent <work-id> --revision N --purpose P
                                    Print the record and the new intent.
  intents [--repository R] [--unresolved]
                                    Print launch intents, oldest first.
  resolve-intent <work-id> --revision N --intent I (--thread T | --failure F)
                                    Resolve the intent to T3's thread T, which joins
                                    the record's threads, or to failure F. An intent
                                    resolves once.

Retention and export
  A record is finished once its delivery PR shows it, and the board finishes a
  decision or concept once it is complete; a Status or a closed ticket never
  finishes it. By default this machine keeps finished and set-aside
  records indefinitely and hides them 7 days after they were finished or set
  aside. Deleting them after a number of days is a separate choice.
  retention [--hide-after N] [--delete-after N|never]
                                    Print this machine's retention setting, after
                                    saving the given changes to it.
  hidden                            Print the records the setting hides now.
  delete-expired                    Delete the records the setting deletes now, with
                                    their bodies, review rounds, threads and intents.
                                    Prints the deleted work IDs, and each due record
                                    kept because a kept record it owns or that waits
                                    on it still needs it, or a Dependency it holds or
                                    that blocks it, with the reason.
  export <work-id> --to D           Write the record's brief, decision or map, its
                                    Dependencies, and a concept's decisions, as
                                    markdown files in the existing folder D, named
                                    from each one's first heading. Prints the paths. The files are a copy
                                    to read; changing them changes no record.

Options
  --data-dir D   Use the work-record database in folder D instead of the
                 factory's data folder (${workRecordsPath()}), and the
                 retention setting there.
  --help         Print this help.

Errors
  A failure prints "lar-work: <reason>" on stderr and exits with 1. The reason
  names the record, ticket or file involved, never a credential. Usage mistakes
  exit with 2. Records stay as they were after any failure.
`;

class UsageError extends Error {}

const TAKES_WORK_ID = ['read', 'context', 'update', 'attach-ticket', 'set-aside', 'restore', 'set-needs-you', 'clear-needs-you',
  'publication-pr-body', 'prepare-publication-pr', 'inspect-publication-pr', 'execute-publication-pr', 'reconcile-publication-pr',
  'prepare-publication', 'inspect-publication', 'execute-publication', 'resume-publication', 'reconcile-publication', 'fallback-publication',
  'snapshot-skills', 'set-parent', 'clear-parent', 'add-blocker', 'remove-blocker', 'children', 'blockers', 'dependents', 'completion',
  'waiting-on', 'set-fog', 'finish', 'set-body', 'body', 'set-phase', 'set-pr', 'pr-history', 'record-review-round', 'set-disposition',
  'review-rounds', 'observe', 'observe-failure', 'observations', 'add-thread', 'threads', 'record-intent', 'resolve-intent', 'export',
  'gate', 'record-gate', 'publication-readiness', 'propose-publication', 'publication', 'publications', 'approve-publication',
  'pending-publication', 'claim-publication', 'record-publication-outcome', 'resolve-publication-outcome', 'record-publication-evidence',
  'publication-evidence', 'last-published', 'publication-handover', 'attach-publication-url', 'publication-attachment',
  'add-dependency', 'dependencies'];
const TAKES_DEPENDENCY_ID = ['dependency', 'update-dependency', 'add-dependency-block', 'remove-dependency-block', 'observe-dependency', 'mark-met',
  'clear-met', 'replace-dependency'];
const COMMANDS = ['create', 'import', 'list', 'intents', 'retention', 'hidden', 'delete-expired', ...TAKES_WORK_ID, ...TAKES_DEPENDENCY_ID];

const OPTIONS = {
  plan: { type: 'string' },
  digest: { type: 'string' },
  identity: { type: 'string' },
  evidence: { type: 'string' },
  operation: { type: 'string' },
  claim: { type: 'string' },
  url: { type: 'string' },
  title: { type: 'string' },
  repository: { type: 'string' },
  kind: { type: 'string' },
  status: { type: 'string' },
  ticket: { type: 'string' },
  revision: { type: 'string' },
  parent: { type: 'string' },
  blocker: { type: 'string' },
  build: { type: 'string' },
  subject: { type: 'string' },
  detail: { type: 'string' },
  body: { type: 'string' },
  file: { type: 'string' },
  phase: { type: 'string' },
  pr: { type: 'string' },
  round: { type: 'string' },
  axis: { type: 'string' },
  finding: { type: 'string' },
  disposition: { type: 'string' },
  reason: { type: 'string' },
  skill: { type: 'string', multiple: true },
  fog: { type: 'string' },
  of: { type: 'string' },
  state: { type: 'string' },
  assignee: { type: 'string' },
  thread: { type: 'string' },
  purpose: { type: 'string' },
  intent: { type: 'string' },
  failure: { type: 'string' },
  unresolved: { type: 'boolean' },
  'hide-after': { type: 'string' },
  'delete-after': { type: 'string' },
  to: { type: 'string' },
  'data-dir': { type: 'string' },
  help: { type: 'boolean' },
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>['values'];

type StringOption = { [K in keyof Values]-?: Values[K] extends string | undefined ? K : never }[keyof Values];

function need(values: Values, name: StringOption): string {
  const value = values[name];
  if (value === undefined) throw new UsageError(`--${name} is required.`);
  return value;
}

/** The text in the file `--file` names, or standard input for `-`. */
function readInput(values: Values): string {
  const file = need(values, 'file');
  try {
    return readFileSync(file === '-' ? 0 : file, 'utf8');
  } catch (error) {
    throw new WorkRecordError('invalid', `Can't read ${file === '-' ? 'standard input' : file}: ${(error as Error).message}.`);
  }
}

/** A publication request or Dependency in JSON, named as `what`, validated by the database writer. */
function readJson(values: Values, what = 'publication input'): unknown {
  try {
    return JSON.parse(readInput(values)) as unknown;
  } catch (error) {
    if (error instanceof WorkRecordError) throw error;
    throw new WorkRecordError('invalid', `The ${what} in ${values.file} isn't JSON.`);
  }
}

/** The review round in the JSON `--file` holds. */
function readRound(values: Values): NewReviewRound {
  try {
    return JSON.parse(readInput(values)) as NewReviewRound;
  } catch (error) {
    if (error instanceof WorkRecordError) throw error;
    throw new WorkRecordError('invalid', `The review round in ${values.file} isn't JSON: ${(error as Error).message}.`);
  }
}

/** Saves the retention options given, then returns this machine's setting. */
function retention(values: Values): unknown {
  const days = (name: 'hide-after' | 'delete-after') => {
    const value = values[name]!;
    if (!/^\d+$/.test(value)) throw new UsageError(`--${name} takes a whole number of days${name === 'delete-after' ? ' or never' : ''}.`);
    return Number(value);
  };
  const current = readRetention(values['data-dir']);
  if (values['hide-after'] === undefined && values['delete-after'] === undefined) return current;
  return writeRetention({
    hideAfterDays: values['hide-after'] === undefined ? current.hideAfterDays : days('hide-after'),
    deleteAfterDays: values['delete-after'] === undefined ? current.deleteAfterDays : values['delete-after'] === 'never' ? null : days('delete-after'),
  }, values['data-dir']);
}

/** Runs `command`; `workId` is the work ID or Dependency ID for the commands that take one. A string result prints as it is, anything else as JSON. */
async function run(records: WorkRecords, command: string, workId: string | undefined, values: Values): Promise<unknown> {
  const revision = () => Number(need(values, 'revision'));
  const status = values.status as Status | undefined;
  const kind = values.kind as WorkKind | undefined;
  const captured = () => ({
    title: need(values, 'title'), repository: need(values, 'repository'), kind: need(values, 'kind') as WorkKind, status,
    context: values.file === undefined ? undefined : readInput(values),
  });
  switch (command) {
    case 'publication-pr-body':
      return publicationPr(records).body(workId!, readInput(values));
    case 'prepare-publication-pr':
      return publicationPr(records, { dir: values['data-dir'] }).prepare(workId!);
    case 'inspect-publication-pr':
      return publicationPr(records, { dir: values['data-dir'] }).inspect(workId!, need(values, 'plan'));
    case 'execute-publication-pr':
      return publicationPr(records, { dir: values['data-dir'] }).execute(workId!, need(values, 'plan'), need(values, 'identity'));
    case 'reconcile-publication-pr':
      return publicationPr(records, { dir: values['data-dir'] }).reconcile(workId!, need(values, 'plan'), need(values, 'identity'));
    case 'prepare-publication':
      return publicationEngine(records, { dir: values['data-dir'] }).prepare(workId!, readJson(values) as PreparePublication);
    case 'inspect-publication':
      return publicationEngine(records, { dir: values['data-dir'] }).inspect(workId!, need(values, 'plan'));
    case 'execute-publication':
    case 'resume-publication':
      return publicationEngine(records, { dir: values['data-dir'] }).execute(workId!, need(values, 'plan'), need(values, 'identity'));
    case 'reconcile-publication':
      return publicationEngine(records, { dir: values['data-dir'] }).reconcile(workId!, need(values, 'plan'), need(values, 'identity'), values.file === undefined ? [] : readJson(values) as ReconciliationSelection[]);
    case 'fallback-publication': {
      const input = values.file === undefined ? {} : readJson(values);
      if (!isRecord(input) || (input.delivery !== undefined && input.delivery !== 'comment' && input.delivery !== 'handover')) throw new WorkRecordError('invalid', 'Choose comment or handover fallback in a JSON object.');
      return publicationEngine(records, { dir: values['data-dir'] }).fallback(workId!, need(values, 'plan'), input.delivery as 'comment' | 'handover' | undefined);
    }
    case 'gate':
      return records.gate(workId!);
    case 'record-gate':
      return records.recordGate(workId!, revision(), { briefDigest: need(values, 'digest'), approvedBy: need(values, 'identity'), evidence: need(values, 'evidence') });
    case 'publication-readiness':
      return records.publicationReadiness(workId!);
    case 'propose-publication':
      return records.proposePublication(workId!, revision(), readJson(values) as PublicationProposal);
    case 'publication':
      return records.publication(workId!, need(values, 'plan'));
    case 'publications':
      return records.publications(workId!);
    case 'approve-publication':
      return records.approvePublication(workId!, need(values, 'plan'), revision(), need(values, 'digest'), need(values, 'identity'));
    case 'pending-publication':
      return records.pendingPublication(workId!, need(values, 'plan'), values.file === undefined ? undefined : readJson(values) as PublicationContent);
    case 'claim-publication':
      return records.claimPublication(workId!, need(values, 'plan'), revision(), need(values, 'digest'), readJson(values) as PublicationContent, need(values, 'identity'));
    case 'record-publication-outcome':
      return records.recordPublicationOutcome(workId!, need(values, 'plan'), revision(), need(values, 'operation'), need(values, 'claim'), readJson(values) as PublicationOutcome);
    case 'resolve-publication-outcome':
      return records.resolvePublicationOutcome(workId!, need(values, 'plan'), revision(), need(values, 'operation'), need(values, 'identity'), readJson(values) as PublicationOutcome);
    case 'record-publication-evidence':
      return records.recordPublicationEvidence(workId!, need(values, 'plan'), revision(), need(values, 'operation'), need(values, 'evidence'));
    case 'publication-evidence':
      return records.publicationEvidence(workId!, need(values, 'plan'));
    case 'last-published':
      return records.lastPublished(workId!);
    case 'publication-handover':
      return records.publicationHandover(workId!, need(values, 'plan'));
    case 'publication-attachment':
      return records.publicationAttachment(workId!);
    case 'attach-publication-url':
      return records.attachPublicationUrl(workId!, revision(), need(values, 'plan'), need(values, 'ticket'), need(values, 'url'));
    case 'create':
      return records.create({ ...captured(), ticket: values.ticket });
    case 'import':
      return records.importTicket({ ...captured(), ticket: need(values, 'ticket') });
    case 'read':
      return records.read(workId!);
    case 'context':
      return records.initialContext(workId!);
    case 'list':
      return records.list({ repository: values.repository, status, kind });
    case 'update':
      return records.update(workId!, revision(), { status, kind });
    case 'attach-ticket':
      return records.attachTicket(workId!, revision(), need(values, 'ticket'));
    case 'set-aside':
      return records.setAside(workId!, revision());
    case 'restore':
      return records.restore(workId!, revision());
    case 'set-needs-you':
      return records.setNeedsYou(workId!, revision(), need(values, 'reason'));
    case 'clear-needs-you':
      return records.clearNeedsYou(workId!, revision());
    case 'snapshot-skills':
      return records.snapshotSkills(workId!, revision(), values.skill ?? []);
    case 'set-parent':
      return records.setParent(workId!, revision(), need(values, 'parent'));
    case 'clear-parent':
      return records.clearParent(workId!, revision());
    case 'add-blocker':
      return records.addBlocker(workId!, revision(), need(values, 'blocker'));
    case 'remove-blocker':
      return records.removeBlocker(workId!, revision(), need(values, 'blocker'));
    case 'children':
      return records.children(workId!);
    case 'blockers':
      return [...records.blockers(workId!), ...records.unmetDependencies(workId!)];
    case 'dependents':
      return records.dependents(workId!);
    case 'completion':
      return records.completion(workId!);
    case 'waiting-on':
      return records.waitingOn(workId!);
    case 'set-fog': {
      const fog = need(values, 'fog');
      if (fog !== 'gone' && fog !== 'remaining') throw new UsageError('--fog takes gone or remaining.');
      return records.setFogGone(workId!, revision(), fog === 'gone');
    }
    case 'finish':
      if (records.read(workId!).kind !== 'slice') throw new WorkRecordError('invalid', 'Only a slice is finished by hand; a build finishes when its PR is observed merged.');
      return records.recordFinished(workId!, revision());
    case 'set-body':
      return records.setBody(workId!, revision(), need(values, 'body') as Body, readInput(values));
    case 'body': {
      const body = need(values, 'body') as Body;
      const markdown = records.body(workId!, body);
      if (markdown === null) throw new WorkRecordError('not-found', `The work record ${workId} has no ${body}.`);
      return markdown;
    }
    case 'set-phase':
      return records.setBuildPhase(workId!, revision(), need(values, 'phase') as BuildPhase);
    case 'set-pr':
      return records.setPullRequest(workId!, revision(), need(values, 'pr'));
    case 'pr-history':
      return records.replacedPullRequests(workId!);
    case 'record-review-round':
      return records.recordReviewRound(workId!, revision(), readRound(values));
    case 'set-disposition':
      return records.setFindingDisposition(workId!, revision(),
        { round: Number(need(values, 'round')), axis: need(values, 'axis') as ReviewAxis, finding: Number(need(values, 'finding')) },
        need(values, 'disposition') as FindingDisposition, values.reason);
    case 'review-rounds':
      return records.reviewRounds(workId!);
    case 'observe':
      return records.observe(workId!, revision(), { of: need(values, 'of'), state: need(values, 'state'), assignee: values.assignee } as NewObservation);
    case 'observe-failure':
      return records.recordReadFailure(workId!, revision(), need(values, 'of') as Observed, need(values, 'failure'));
    case 'observations':
      return records.observations(workId!);
    case 'add-thread':
      return records.addThread(workId!, revision(), need(values, 'thread'), need(values, 'purpose'));
    case 'threads':
      return records.threads(workId!);
    case 'record-intent':
      return records.recordLaunchIntent(workId!, revision(), need(values, 'purpose'));
    case 'intents':
      return records.launchIntents({ repository: values.repository, unresolved: values.unresolved });
    case 'resolve-intent': {
      if ((values.thread === undefined) === (values.failure === undefined)) throw new UsageError('resolve-intent needs --thread or --failure, not both.');
      const outcome = values.thread !== undefined ? { threadId: values.thread } : { failure: values.failure! };
      return records.resolveLaunchIntent(workId!, revision(), need(values, 'intent'), outcome);
    }
    case 'add-dependency':
      return records.addDependency(workId!, readJson(values, 'Dependency') as NewDependency);
    case 'dependencies':
      return records.dependencies(workId!);
    case 'dependency':
      return records.dependency(workId!);
    case 'update-dependency':
      return records.updateDependency(workId!, revision(), readJson(values, 'Dependency change') as DependencyChange);
    case 'add-dependency-block':
      return records.addDependencyBlock(workId!, revision(), need(values, 'build'));
    case 'remove-dependency-block':
      return records.removeDependencyBlock(workId!, revision(), need(values, 'build'));
    case 'observe-dependency':
      return records.observeDependency(workId!, revision(),
        { subject: need(values, 'subject'), kind: need(values, 'state') as DependencyObservationKind, detail: values.detail });
    case 'mark-met':
      return records.markDependencyMet(workId!, revision(), need(values, 'identity'));
    case 'clear-met':
      return records.clearDependencyMet(workId!, revision());
    case 'replace-dependency':
      return records.replaceDependencyWithBuild(workId!, revision(), need(values, 'build'));
    case 'hidden':
      return records.hidden(readRetention(values['data-dir']));
    case 'delete-expired':
      return records.deleteExpired(readRetention(values['data-dir']));
    case 'export':
      return exportMarkdown(records, workId!, resolve(need(values, 'to')));
    default:
      throw new UsageError(`Unknown command "${command}".`);
  }
}

async function main(args: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args, options: OPTIONS, allowPositionals: true });
  } catch (error) {
    process.stderr.write(`lar-work: ${(error as Error).message}\nRun lar-work --help for usage.\n`);
    return 2;
  }
  const { values, positionals: [command, workId, ...extra] } = parsed;
  if (values.help || !command) {
    process.stdout.write(HELP);
    return values.help ? 0 : 2;
  }
  let records: WorkRecords | undefined;
  try {
    if (extra.length) throw new UsageError(`Unexpected arguments: ${extra.join(' ')}.`);
    if (!COMMANDS.includes(command)) throw new UsageError(`Unknown command "${command}".`);
    const takesId = TAKES_WORK_ID.includes(command) || TAKES_DEPENDENCY_ID.includes(command);
    if (takesId !== (workId !== undefined)) {
      const id = TAKES_DEPENDENCY_ID.includes(command) ? 'a Dependency ID' : 'a work ID';
      throw new UsageError(workId === undefined ? `${command} needs ${id}.` : `${command} takes no work ID.`);
    }
    if (command === 'retention') {
      process.stdout.write(`${JSON.stringify(retention(values), null, 2)}\n`);
      return 0;
    }
    records = await openWorkRecords(workRecordsPath(values['data-dir']));
    const result = await run(records, command, workId, values);
    process.stdout.write(typeof result === 'string' ? result : `${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`lar-work: ${error.message}\nRun lar-work --help for usage.\n`);
      return 2;
    }
    if (error instanceof PublicationConflict) {
      process.stderr.write(`${JSON.stringify({ error: 'publication-conflict', message: error.message, conflict: error.conflict })}\n`);
      return 1;
    }
    if (error instanceof PublicationRefused) {
      process.stderr.write(`${JSON.stringify({ error: 'publication-refused', message: error.message, alternatives: error.alternatives ?? ['comment', 'handover'] })}\n`);
      return 1;
    }
    if (error instanceof WorkRecordError) {
      process.stderr.write(`lar-work: ${error.message}\n`);
      return 1;
    }
    throw error;
  } finally {
    records?.close();
  }
}

process.exitCode = await main(process.argv.slice(2));
