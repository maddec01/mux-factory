// The factory's work records: the one module that writes the work-record database. Each operation validates its input
// first and runs in one transaction, so a refused or failed change leaves every record as it was. Every change names
// the revision it read; a stale revision changes nothing, so the board and threads never overwrite each other's work.

import { createHash, randomUUID } from 'node:crypto';
import type { StatementSync } from 'node:sqlite';
import { STATUSES, type Status } from '@lar-factory/shared';
import { openDatabase, WorkRecordError, workRecordsPath, type Database } from './database.ts';
import { dependencyRecords, forgetDependencies, type DependencyRecords } from './dependencies.ts';
import { publicationRecords, type PublicationRecords } from './publication-records.ts';
import type { Retention } from './retention.ts';

export { WorkRecordError, workRecordsPath, type WorkRecordErrorCode } from './database.ts';
export { DEPENDENCY_OBSERVATION_KINDS, type Dependency, type DependencyChange, type DependencyObservationKind, type NewDependency } from './dependencies.ts';
export { DEFAULT_RETENTION, readRetention, retentionPath, writeRetention, type Retention } from './retention.ts';

/** The board's kinds, plus a build's slice. */
export const WORK_KINDS = ['bug', 'feature', 'improvement', 'concept', 'decision', 'build', 'slice', 'issue'] as const;
export type WorkKind = (typeof WORK_KINDS)[number];

/** The stages of the lar-build workflow (`skills/lar-build/agents/builder.md`): Build's plan, implement, domain docs and
 * full check suite steps, then Review, Approve, Checks and Retro. A Small build skips plan. */
export const BUILD_PHASES = ['plan', 'implement', 'domain-docs', 'full-checks', 'review', 'approve', 'checks', 'retro'] as const;
export type BuildPhase = (typeof BUILD_PHASES)[number];

/** A record's private markdown: a concept's map; a decision's text, confirmed answer and domain drafts; or any other
 * record's brief. */
export const BODIES = ['brief', 'decision', 'map', 'answer', 'domain-drafts'] as const;
export type Body = (typeof BODIES)[number];
/** Each body as a sentence names it. */
const BODY_NAMES: Record<Body, string> = { brief: 'a brief', decision: 'a decision', map: 'a map', answer: 'an answer', 'domain-drafts': 'domain drafts' };
/** The kind that alone holds each body; a body without one is a brief, which every other kind holds. */
const BODY_HOLDERS: Partial<Record<Body, WorkKind>> = { map: 'concept', decision: 'decision', answer: 'decision', 'domain-drafts': 'decision' };

/** The lar-build reviewers, one axis each (`skills/lar-build/agents/builder.md`, Review). */
export const REVIEW_AXES = ['code', 'security', 'ui', 'performance'] as const;
export type ReviewAxis = (typeof REVIEW_AXES)[number];
/** A reviewer's verdict, or `skipped` when the builder didn't run it. */
export const REVIEW_VERDICTS = ['approve', 'changes', 'skipped'] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];
export const FINDING_SEVERITIES = ['blocker', 'should', 'nit'] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];
/** What became of a finding: still open, fixed, or rejected with a reason. */
export const FINDING_DISPOSITIONS = ['open', 'fixed', 'rejected'] as const;
export type FindingDisposition = (typeof FINDING_DISPOSITIONS)[number];

export interface ReviewFinding {
  severity: FindingSeverity;
  /** The reviewer's finding as it gave it, location and fix included. */
  summary: string;
  disposition: FindingDisposition;
  /** Why it was rejected; null otherwise. */
  reason: string | null;
}

export interface AxisReview {
  axis: ReviewAxis;
  verdict: ReviewVerdict;
  /** What the reviewer couldn't check, or why a skipped axis was skipped. */
  notChecked: string | null;
  findings: ReviewFinding[];
}

export interface ReviewRound {
  /** Counts the build's rounds from 1. */
  round: number;
  /** The commit the round reviewed from. */
  base: string;
  recordedAt: string;
  reviewers: AxisReview[];
}

export interface NewReviewRound {
  base: string;
  reviewers: readonly {
    axis: ReviewAxis;
    verdict: ReviewVerdict;
    notChecked?: string;
    findings: readonly { severity: FindingSeverity; summary: string; disposition: FindingDisposition; reason?: string }[];
  }[];
}

/** One finding: the `finding`th the `axis` reviewer gave in `round`, counting from 1. */
export interface FindingRef {
  round: number;
  axis: ReviewAxis;
  finding: number;
}

export interface RecordedThread {
  /** T3's thread ID. */
  threadId: string;
  /** What the thread does for the record, such as `shape` or `build`. */
  purpose: string;
  recordedAt: string;
}

/** A start the board asked T3 for. This module only stores it and its outcome; it never launches or checks a thread. */
export interface LaunchIntent {
  intentId: string;
  workId: string;
  /** What the thread will do, as a recorded thread's purpose. */
  purpose: string;
  requestedAt: string;
  /** `started` with T3's thread ID, `failed` with the reason, or null while unresolved. */
  outcome: 'started' | 'failed' | null;
  threadId: string | null;
  failure: string | null;
  resolvedAt: string | null;
}

/** What a provider read observes: the record's ticket or its current PR. */
export const OBSERVED = ['ticket', 'pr'] as const;
export type Observed = (typeof OBSERVED)[number];
/** A ticket's state as its provider shows it, or a confirmed not-found. */
export const TICKET_STATES = ['open', 'closed', 'not-found'] as const;
export type TicketState = (typeof TICKET_STATES)[number];
/** A PR's state; `closed` is closed unmerged. */
export const PULL_REQUEST_STATES = ['open', 'merged', 'closed'] as const;
export type PullRequestState = (typeof PULL_REQUEST_STATES)[number];

export type NewObservation = { of: 'ticket'; state: TicketState; assignee?: string } | { of: 'pr'; state: PullRequestState };

/** The last provider read of a record's ticket or current PR. */
export interface Observation {
  of: Observed;
  /** The ticket or PR it read, `owner/name#12`. */
  subject: string;
  /** What the last successful read showed, or null while no read has succeeded. */
  state: TicketState | PullRequestState | null;
  /** The ticket's assignee at that read; always null for a PR. */
  assignee: string | null;
  observedAt: string | null;
  /** When the latest read failed and why, kept until a read succeeds; null otherwise. */
  failedAt: string | null;
  failure: string | null;
}

export interface ReplacedPullRequest {
  pullRequest: string;
  replacedAt: string;
}

export interface LaunchIntentFilter {
  repository?: string;
  workId?: string;
  /** Only the intents still waiting for their outcome. */
  unresolved?: boolean;
}

/** The kinds that never become a PR of their own, so hold no build phase or PR. */
const UNBUILT_KINDS: readonly WorkKind[] = ['concept', 'decision', 'slice'];

/** The kinds each kind may own as a structural parent. */
const CHILD_KINDS: Partial<Record<WorkKind, readonly WorkKind[]>> = { concept: ['decision', 'build'], build: ['slice'] };

export interface WorkRecord {
  /** The record's local identity, fixed for its life whether or not it has a ticket. */
  workId: string;
  /** The title it was captured or imported with; empty on a record made before titles were kept. */
  title: string;
  /** The repository the work belongs to, as the board names it: `owner/name`. */
  repository: string;
  kind: WorkKind;
  status: Status;
  /** A Queued record's place in its repository's Queue; null in every other Status. */
  queueOrder: number | null;
  /** Its published ticket, `owner/name#number`, or null while it has none. */
  ticket: string | null;
  /** The work ID of the record that owns it, or null while it has no parent. */
  parentId: string | null;
  /** Where its build stands, or null before it starts. */
  buildPhase: BuildPhase | null;
  /** The PR its build delivers through, `owner/name#number`, or null before one is recorded. */
  pullRequest: string | null;
  /** Whether it is set aside, which leaves its Status as it was. */
  setAside: boolean;
  /** Whether a concept's Fog is recorded gone; always false for other kinds. */
  fogGone: boolean;
  /** Why it waits on the user, such as a closed unmerged PR; null when it doesn't. Its Status stays as it was. */
  needsYou: string | null;
  /** The project skills selected when its build started, or null before it starts. Later selections never change it. */
  skills: string[] | null;
  /** When its work was finished, as its delivery PR showed, or null while unfinished. A Status never implies it. */
  finishedAt: string | null;
  /** Counts the record's changes; every change names the revision it read. */
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface NewWorkRecord {
  /** One line. Capture or import sets it, and a later ticket edit never overwrites it. */
  title: string;
  /** The markdown the work began with, such as its ticket's text. Empty by default; never overwritten. */
  context?: string;
  repository: string;
  kind: WorkKind;
  status?: Status;
  ticket?: string;
}

/** What deleting expired records did: the records it deleted, and each due record it kept with the reason. */
export interface Expired {
  deleted: string[];
  kept: { workId: string; reason: string }[];
}

/** Whether a record's work is complete, and each reason it isn't yet. */
export interface Completion {
  complete: boolean;
  reasons: string[];
}

export interface WorkRecordFilter {
  repository?: string;
  status?: Status;
  kind?: WorkKind;
}

export interface WorkRecords extends PublicationRecords, DependencyRecords {
  create(record: NewWorkRecord): WorkRecord;
  /** Throws `not-found` when no record has `workId`. */
  read(workId: string): WorkRecord;
  /** The markdown the record began with, or an empty string. */
  initialContext(workId: string): string;
  /** The matching records, Queued ones in Queue order first, then the rest in the order they were made. */
  list(filter: WorkRecordFilter): WorkRecord[];
  update(workId: string, revision: number, change: { status?: Status; kind?: WorkKind }): WorkRecord;
  /** Gives a ticketless record its ticket. The work ID stays; a record can't swap one ticket for another. */
  attachTicket(workId: string, revision: number, ticket: string): WorkRecord;
  /** The record holding `ticket`, made first when none does yet. An existing record keeps its title and context. */
  importTicket(record: NewWorkRecord & { ticket: string }): { record: WorkRecord; created: boolean };
  setAside(workId: string, revision: number): WorkRecord;
  /** Records why the work waits on the user, replacing an earlier reason. */
  setNeedsYou(workId: string, revision: number, reason: string): WorkRecord;
  clearNeedsYou(workId: string, revision: number): WorkRecord;
  /** Records the project skills selected as the build starts. A build snapshots its skills once. */
  snapshotSkills(workId: string, revision: number, skills: readonly string[]): WorkRecord;
  restore(workId: string, revision: number): WorkRecord;
  /** Puts the record under `parentId`, whose kind must own the record's kind. Clear a parent before setting another. */
  setParent(workId: string, revision: number, parentId: string): WorkRecord;
  clearParent(workId: string, revision: number): WorkRecord;
  /** Records that the work waits on `blockerId`. Refuses a self-blocker and an edge that would close a cycle. */
  addBlocker(workId: string, revision: number, blockerId: string): WorkRecord;
  removeBlocker(workId: string, revision: number, blockerId: string): WorkRecord;
  /** Writes the record's `body`, replacing any earlier one. A concept holds a map, a decision its text, others a brief. */
  setBody(workId: string, revision: number, body: Body, markdown: string): WorkRecord;
  /** Restores absent imported refinement and its initial relationships in one transaction. An existing body preserves all local state. */
  restoreImported(workId: string, revision: number, imported: { body: Body; markdown: string; parentId?: string; blockerIds?: readonly string[] }): WorkRecord;
  /** The record's `body`, or null while it has none. */
  body(workId: string, body: Body): string | null;
  setBuildPhase(workId: string, revision: number, phase: BuildPhase): WorkRecord;
  /** Records the PR the build delivers through. A record holds one current PR; a replaced one joins its history. */
  setPullRequest(workId: string, revision: number, pullRequest: string): WorkRecord;
  /** The PRs the record held before its current one, oldest first. */
  replacedPullRequests(workId: string): ReplacedPullRequest[];
  /** Records a successful read of the record's ticket or current PR, replacing the last one of its kind. A merged PR
   * finishes the work. */
  observe(workId: string, revision: number, observation: NewObservation): WorkRecord;
  /** Records that a read failed, keeping the last observation of its kind. */
  recordReadFailure(workId: string, revision: number, of: Observed, failure: string): WorkRecord;
  /** Its ticket's observation, then its current PR's, for each it has. */
  observations(workId: string): Observation[];
  /** Records the build's next review round with every axis and finding, whole or not at all. */
  recordReviewRound(workId: string, revision: number, round: NewReviewRound): WorkRecord;
  /** Records what became of a finding. A rejection needs its reason. */
  setFindingDisposition(workId: string, revision: number, finding: FindingRef, disposition: FindingDisposition, reason?: string): WorkRecord;
  /** The build's review rounds, oldest first. */
  reviewRounds(workId: string): ReviewRound[];
  /** Records a T3 thread that works on the record. A thread works on one record only. */
  addThread(workId: string, revision: number, threadId: string, purpose: string): WorkRecord;
  /** Its recorded threads, oldest first. */
  threads(workId: string): RecordedThread[];
  /** Records that the board is about to ask T3 for a thread, before it asks. */
  recordLaunchIntent(workId: string, revision: number, purpose: string): { record: WorkRecord; intent: LaunchIntent };
  /** The matching intents in the order they were recorded. */
  launchIntents(filter: LaunchIntentFilter): LaunchIntent[];
  /** Resolves an unresolved intent once: to T3's thread ID, which it records as the record's thread, or to a failure. */
  resolveLaunchIntent(workId: string, revision: number, intentId: string, outcome: { threadId: string } | { failure: string }): { record: WorkRecord; intent: LaunchIntent };
  /** Records that the work is finished. A merged observation of the delivery PR finishes the work too; a ticket closing
   * or a thread ending never does. A finish is final. */
  recordFinished(workId: string, revision: number): WorkRecord;
  /** The finished and set-aside records `retention` hides at `now`, in the order they were made. */
  hidden(retention: Retention, now?: Date): WorkRecord[];
  /** Deletes the finished and set-aside records `retention` deletes at `now`, with their bodies, review rounds, threads,
   * launch intents, replaced PRs, observations and blocker edges, in one transaction. A due record stays while it owns a kept record or a kept
   * record waits on it, and while it holds a Dependency or one blocks it; the kept parent and blockers of a deleted record are bumped. */
  deleteExpired(retention: Retention, now?: Date): Expired;
  /** The records it owns, in the order they were made. */
  children(workId: string): WorkRecord[];
  /** The records it waits on. */
  blockers(workId: string): WorkRecord[];
  /** Whether the work is complete, from local facts only. A build or other built record completes once its recorded PR
   * is observed merged, a slice once it is finished, a decision once its answer and domain drafts are recorded and its
   * concept's map was written after them, and a concept once its Fog is gone and every decision and build it owns,
   * except set-aside ones, is complete. A build stays incomplete while an unmet Dependency holds it. A Status, a ticket
   * closing or a thread ending never completes work. */
  completion(workId: string): Completion;
  /** Its blockers that aren't complete yet, then the unmet Dependencies holding it, each with the reasons; the work can
   * start once this is empty. */
  waitingOn(workId: string): ({ workId: string; reasons: string[] } | { dependencyId: string; reasons: string[] })[];
  /** Records whether a concept's Fog is gone. */
  setFogGone(workId: string, revision: number, gone: boolean): WorkRecord;
  /** The records that wait on it. */
  dependents(workId: string): WorkRecord[];
  close(): void;
}

interface Row {
  work_id: string;
  title: string;
  initial_context: string;
  repository: string;
  kind: WorkKind;
  status: Status;
  queue_order: number | null;
  ticket: string | null;
  parent_id: string | null;
  build_phase: BuildPhase | null;
  pull_request: string | null;
  set_aside_at: string | null;
  fog_gone_at: string | null;
  needs_you: string | null;
  skills: string | null;
  finished_at: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

const fromRow = (row: Row): WorkRecord => ({
  workId: row.work_id,
  title: row.title,
  repository: row.repository,
  kind: row.kind,
  status: row.status,
  queueOrder: row.queue_order,
  ticket: row.ticket,
  parentId: row.parent_id,
  buildPhase: row.build_phase,
  pullRequest: row.pull_request,
  setAside: row.set_aside_at !== null,
  fogGone: row.fog_gone_at !== null,
  needsYou: row.needs_you,
  skills: row.skills === null ? null : JSON.parse(row.skills) as string[],
  finishedAt: row.finished_at,
  revision: row.revision,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

interface IntentRow {
  intent_id: string;
  work_id: string;
  purpose: string;
  requested_at: string;
  thread_id: string | null;
  failure: string | null;
  resolved_at: string | null;
}

const fromIntentRow = (row: IntentRow): LaunchIntent => ({
  intentId: row.intent_id,
  workId: row.work_id,
  purpose: row.purpose,
  requestedAt: row.requested_at,
  outcome: row.thread_id ? 'started' : row.failure ? 'failed' : null,
  threadId: row.thread_id,
  failure: row.failure,
  resolvedAt: row.resolved_at,
});

/** When a finished or set-aside record left active work, or null while it is active. */
const retiredAt = (row: Row): string | null =>
  row.finished_at && row.set_aside_at ? (row.finished_at < row.set_aside_at ? row.finished_at : row.set_aside_at) : row.finished_at ?? row.set_aside_at;

/** The finished and set-aside rows that left active work at least `days` days before `now`. */
function dueRows(rows: readonly Row[], days: number, now: Date): Row[] {
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
  return rows.filter((row) => { const at = retiredAt(row); return at !== null && at <= cutoff; });
}

const invalid = (message: string) => new WorkRecordError('invalid', message);

function checkRepository(repository: unknown): string {
  if (typeof repository !== 'string' || !/^[^\s/]+(\/[^\s/]+)+$/.test(repository)) throw invalid(`The repository "${String(repository)}" isn't a repository name like owner/name.`);
  return repository;
}

/** Throws unless `value` is one of `values`, naming it as `what`. */
function checkOneOf<T extends string>(values: readonly T[], value: unknown, what: string): T {
  if (!values.includes(value as T)) throw invalid(`The ${what} "${String(value)}" isn't one of ${values.join(', ')}.`);
  return value as T;
}

const checkKind = (kind: unknown): WorkKind => checkOneOf(WORK_KINDS, kind, 'kind');
const checkStatus = (status: unknown): Status => checkOneOf(STATUSES, status, 'Status');

/** Throws unless `reference` names a ticket or PR: `owner/name#12`. */
function checkReference(reference: unknown, what: 'ticket' | 'PR'): string {
  if (typeof reference !== 'string' || !/^[^\s/#]+(\/[^\s/#]+)+#[1-9]\d*$/.test(reference)) {
    throw invalid(`The ${what} "${String(reference)}" isn't a ${what} reference like owner/name#12.`);
  }
  return reference;
}

const checkTicket = (ticket: unknown): string => checkReference(ticket, 'ticket');

/** Throws unless a record of `kind` holds `body`. */
function checkHolds(kind: WorkKind, body: Body): void {
  const holder = BODY_HOLDERS[body];
  if (holder ? kind !== holder : kind === 'concept' || kind === 'decision') {
    throw invalid(holder ? `Only a ${holder} holds ${BODY_NAMES[body]}; this record is a ${kind}.` : `A ${kind} holds no brief.`);
  }
}

/** Throws unless a record of `kind` can be built. */
function checkBuilt(kind: WorkKind): void {
  if (UNBUILT_KINDS.includes(kind)) throw invalid(`A ${kind} is never built, so it has no build phase, PR, skills or review rounds.`);
}

function checkTitle(title: unknown): string {
  if (typeof title !== 'string' || !title.trim() || /[\r\n]/.test(title)) throw invalid(`The title "${String(title)}" is empty, isn't text or has more than one line.`);
  return title;
}

function checkText(text: unknown, what: string): string {
  if (typeof text !== 'string') throw invalid(`The ${what} isn't text.`);
  return text;
}

function checkFilled(text: unknown, what: string): string {
  if (typeof text !== 'string' || !text.trim()) throw invalid(`The ${what} is empty or isn't text.`);
  return text;
}

function checkSkills(skills: unknown): string[] {
  if (!Array.isArray(skills)) throw invalid("The skills aren't a list.");
  for (const [index, skill] of skills.entries()) {
    if (typeof skill !== 'string' || !/^\S+$/.test(skill)) throw invalid(`The skill "${String(skill)}" is empty or has spaces.`);
    if (skills.indexOf(skill) !== index) throw invalid(`The skills list ${skill} twice.`);
  }
  return skills as string[];
}

function checkThreadId(threadId: unknown): string {
  if (typeof threadId !== 'string' || !/^\S+$/.test(threadId)) throw invalid(`The thread ID "${String(threadId)}" is empty or has spaces.`);
  return threadId;
}

function checkPurpose(purpose: unknown): string {
  if (typeof purpose !== 'string' || !/^[a-z][a-z0-9-]*$/.test(purpose)) throw invalid(`The purpose "${String(purpose)}" isn't a lowercase word like build.`);
  return purpose;
}

/** A finding's disposition and the reason a rejection needs. */
function checkDisposition(disposition: unknown, reason: unknown): [FindingDisposition, string | null] {
  const checked = checkOneOf(FINDING_DISPOSITIONS, disposition, 'disposition');
  if (checked !== 'rejected') return [checked, null];
  return [checked, checkFilled(reason, 'reason for rejecting a finding')];
}

/** Throws unless a `parent` may own a `child`. */
function checkOwns(parent: Row, child: { work_id: string; kind: WorkKind }): void {
  const owns = CHILD_KINDS[parent.kind] ?? [];
  if (!owns.includes(child.kind)) {
    throw invalid(`A ${parent.kind} owns ${owns.length ? `only ${owns.join(' and ')} records` : 'no records'}, so ${parent.work_id} can't own the ${child.kind} ${child.work_id}.`);
  }
}

function checkRevision(revision: unknown): number {
  if (!Number.isSafeInteger(revision) || (revision as number) < 1) throw invalid(`The revision "${String(revision)}" isn't a whole number from 1.`);
  return revision as number;
}

/** Opens the work records in the database at `path`, the factory data folder's by default. */
export async function openWorkRecords(path = workRecordsPath()): Promise<WorkRecords> {
  return workRecords(await openDatabase(path));
}

function workRecords(database: Database): WorkRecords {
  const { db } = database;
  const select = db.prepare('SELECT * FROM work_records WHERE work_id = ?');
  const byTicket = db.prepare('SELECT * FROM work_records WHERE ticket = ?');
  const childRows = db.prepare('SELECT * FROM work_records WHERE parent_id = ? ORDER BY rowid');
  const blockerRows = db.prepare('SELECT r.* FROM blockers b JOIN work_records r ON r.work_id = b.blocker_id WHERE b.work_id = ? ORDER BY b.rowid');
  const dependentRows = db.prepare('SELECT r.* FROM blockers b JOIN work_records r ON r.work_id = b.work_id WHERE b.blocker_id = ? ORDER BY b.rowid');
  const hasBlocker = db.prepare('SELECT 1 FROM blockers WHERE work_id = ? AND blocker_id = ?');
  const insertBlocker = db.prepare('INSERT INTO blockers (work_id, blocker_id) VALUES (?, ?)');
  const deleteBlocker = db.prepare('DELETE FROM blockers WHERE work_id = ? AND blocker_id = ?');
  // Whether `blocker` already waits on `work`, directly or through other records.
  const waitsOn = db.prepare(`WITH RECURSIVE waiting (id) AS (SELECT ? UNION SELECT b.blocker_id FROM blockers b JOIN waiting ON b.work_id = waiting.id)
    SELECT 1 FROM waiting WHERE id = ?`);
  const bump = db.prepare('UPDATE work_records SET revision = revision + 1, updated_at = ? WHERE work_id = ?');
  const hasRounds = db.prepare('SELECT 1 FROM review_rounds WHERE work_id = ? LIMIT 1');
  const roundRows = db.prepare('SELECT * FROM review_rounds WHERE work_id = ? ORDER BY round');
  const axisRows = db.prepare('SELECT * FROM review_axes WHERE work_id = ? AND round = ? ORDER BY rowid');
  const findingRows = db.prepare('SELECT * FROM review_findings WHERE work_id = ? AND round = ? AND axis = ? ORDER BY finding');
  const nextRound = db.prepare('SELECT coalesce(max(round), 0) + 1 AS next FROM review_rounds WHERE work_id = ?');
  const insertRound = db.prepare('INSERT INTO review_rounds (work_id, round, base, recorded_at) VALUES (?, ?, ?, ?)');
  const insertAxis = db.prepare('INSERT INTO review_axes (work_id, round, axis, verdict, not_checked) VALUES (?, ?, ?, ?, ?)');
  const insertFinding = db.prepare('INSERT INTO review_findings (work_id, round, axis, finding, severity, summary, disposition, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const disposeFinding = db.prepare('UPDATE review_findings SET disposition = ?, reason = ? WHERE work_id = ? AND round = ? AND axis = ? AND finding = ?');
  const bodyNames = db.prepare('SELECT body FROM bodies WHERE work_id = ?');
  const bodyText = db.prepare('SELECT markdown FROM bodies WHERE work_id = ? AND body = ?');
  const writeBodyRow = db.prepare(`INSERT INTO bodies (work_id, body, markdown, written, has_content, has_passing_gate)
    VALUES (?, ?, ?, (SELECT coalesce(max(written), 0) + 1 FROM bodies), ?, EXISTS (SELECT 1 FROM brief_gates WHERE work_id = ? AND brief_digest = ?))
    ON CONFLICT DO UPDATE SET markdown = excluded.markdown, written = excluded.written, has_content = excluded.has_content, has_passing_gate = excluded.has_passing_gate`);
  const writeBody = (workId: string, body: Body, markdown: string) => {
    const digest = body === 'brief' && markdown.trim() ? createHash('sha256').update(JSON.stringify(markdown)).digest('hex') : '';
    writeBodyRow.run(workId, body, markdown, Number(Boolean(markdown.trim())), workId, digest);
  };
  const bodyWrittenRow = db.prepare('SELECT written FROM bodies WHERE work_id = ? AND body = ?');
  /** When the body was last written, in the order of every body write; undefined while it has none. */
  const bodyWritten = (workId: string, body: Body): number | undefined => (bodyWrittenRow.get(workId, body)?.written as number | undefined);
  const writeObservation = db.prepare(`INSERT INTO observations (work_id, observed, subject, state, assignee, observed_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT DO UPDATE SET subject = excluded.subject, state = excluded.state, assignee = excluded.assignee, observed_at = excluded.observed_at,
    failed_at = NULL, failure = NULL`);
  const writeReadFailure = db.prepare(`INSERT INTO observations (work_id, observed, subject, failed_at, failure) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT DO UPDATE SET failed_at = excluded.failed_at, failure = excluded.failure`);
  const deleteObservation = db.prepare('DELETE FROM observations WHERE work_id = ? AND observed = ?');
  const observationRows = db.prepare(`SELECT * FROM observations WHERE work_id = ? ORDER BY observed = 'pr'`);
  /** The ticket or PR a read of `of` observes on `row`; throws when the record has none. */
  const subject = (row: Row, of: Observed): string => {
    const reference = of === 'ticket' ? row.ticket : row.pull_request;
    if (!reference) throw invalid(`The work record ${row.work_id} has no ${of === 'ticket' ? 'ticket' : 'PR'} to observe.`);
    return reference;
  };
  const replacePullRequest = db.prepare('INSERT INTO replaced_pull_requests (work_id, pull_request, replaced_at) VALUES (?, ?, ?)');
  const replacedRows = db.prepare('SELECT * FROM replaced_pull_requests WHERE work_id = ? ORDER BY rowid');
  const nextQueueOrder = db.prepare('SELECT coalesce(max(queue_order), 0) + 1 AS next FROM work_records WHERE repository = ?');
  const dependencies = dependencyRecords(database, (workId) => bump.run(new Date().toISOString(), workId));
  const { treeConflict, kindConflict, retentionReason, recordDependencyTicket, ...dependencyChanges } = dependencies;
  const unmetIds = db.prepare('SELECT b.dependency_id, d.owner FROM dependency_blocks b JOIN dependencies d ON d.dependency_id = b.dependency_id WHERE b.build_id = ? AND d.met_at IS NULL ORDER BY b.rowid');
  const unmet = (workId: string) => unmetIds.all(workId).map((row) => ({ dependencyId: String(row.dependency_id), owner: String(row.owner) }));

  const find = (workId: string): Row => {
    const row = select.get(workId) as Row | undefined;
    if (!row) throw new WorkRecordError('not-found', `No work record has the work ID "${workId}".`);
    return row;
  };
  const queueOrder = (repository: string, status: Status, current: number | null = null): number | null =>
    status !== 'Queued' ? null : current ?? Number(nextQueueOrder.get(repository)!.next);

  // Each filtered query's statement, prepared the first time its combination of filters runs.
  const filteredQueries = new Map<string, ReturnType<typeof db.prepare>>();
  /** The rows of `query` that pass each condition with a value: a string it binds, or true for a test that binds none. */
  const filtered = (query: string, order: string, conditions: readonly [test: string, value: string | true | undefined][]) => {
    const used = conditions.filter(([, value]) => value !== undefined);
    const sql = `${query}${used.length ? ` WHERE ${used.map(([test]) => test).join(' AND ')}` : ''} ${order}`;
    let statement = filteredQueries.get(sql);
    if (!statement) filteredQueries.set(sql, (statement = db.prepare(sql)));
    return statement.all(...used.flatMap(([, value]) => (typeof value === 'string' ? [value] : [])));
  };

  const insertRow = db.prepare(`INSERT INTO work_records (work_id, title, initial_context, repository, kind, status, queue_order, ticket, set_aside_at,
    revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?)`);
  const insert = (record: NewWorkRecord): WorkRecord => {
    const repository = checkRepository(record.repository);
    const kind = checkKind(record.kind);
    const status = checkStatus(record.status ?? 'List');
    const ticket = record.ticket === undefined ? null : checkTicket(record.ticket);
    const title = checkTitle(record.title);
    const context = record.context === undefined ? '' : checkText(record.context, 'initial context');
    if (ticket && byTicket.get(ticket)) throw new WorkRecordError('ticket-taken', `Another work record already holds the ticket ${ticket}.`);
    const now = new Date().toISOString();
    const workId = randomUUID();
    insertRow.run(workId, title, context, repository, kind, status, queueOrder(repository, status), ticket, now, now);
    return fromRow(find(workId));
  };

  const updateRow = db.prepare(`UPDATE work_records SET kind = ?, status = ?, queue_order = ?, ticket = ?, parent_id = ?, build_phase = ?,
    pull_request = ?, set_aside_at = ?, fog_gone_at = ?, needs_you = ?, skills = ?, finished_at = ?, revision = ?, updated_at = ? WHERE work_id = ? AND revision = ?`);
  /** Applies `change` to the record at `revision`, bumping it; throws when the record moved on. Records `apply`
   * returns in `touched` are bumped too, so a writer holding their old revision fails instead of overwriting. When
   * `apply` returns null the record already holds the change, so nothing is written or bumped. */
  const change = (workId: string, revision: number, apply: (row: Row, touched: string[]) => Partial<Row> | null): WorkRecord =>
    database.write(() => {
      const expected = checkRevision(revision);
      const row = find(workId);
      if (row.revision !== expected) {
        throw new WorkRecordError('stale-revision', `The work record ${workId} is at revision ${row.revision}, not ${expected}; read it again and retry.`);
      }
      const touched: string[] = [];
      const patch = apply(row, touched);
      if (patch === null) return fromRow(row);
      const next = { ...row, ...patch, revision: row.revision + 1, updated_at: new Date().toISOString() };
      updateRow.run(next.kind, next.status, next.queue_order, next.ticket, next.parent_id, next.build_phase, next.pull_request, next.set_aside_at,
        next.fog_gone_at, next.needs_you, next.skills, next.finished_at, next.revision, next.updated_at, workId, expected);
      for (const id of touched) bump.run(next.updated_at, id);
      return fromRow(find(workId));
    });

  const selectIntent = db.prepare('SELECT * FROM launch_intents WHERE intent_id = ?');
  const insertIntent = db.prepare('INSERT INTO launch_intents (intent_id, work_id, purpose, requested_at) VALUES (?, ?, ?, ?)');
  const resolveIntent = db.prepare('UPDATE launch_intents SET thread_id = ?, failure = ?, resolved_at = ? WHERE intent_id = ?');
  const threadHolder = db.prepare('SELECT work_id FROM threads WHERE thread_id = ?');
  const threadRows = db.prepare('SELECT * FROM threads WHERE work_id = ? ORDER BY rowid');
  const addThreadRow = db.prepare('INSERT INTO threads (thread_id, work_id, purpose, recorded_at) VALUES (?, ?, ?, ?)');
  const intent = (intentId: string) => fromIntentRow(database.read(() => selectIntent.get(intentId)) as unknown as IntentRow);
  const insertThread = (workId: string, threadId: string, purpose: string) => {
    const holder = threadHolder.get(threadId);
    if (holder) throw invalid(`The thread ${threadId} is already recorded on the work record ${String(holder.work_id)}.`);
    addThreadRow.run(threadId, workId, purpose, new Date().toISOString());
  };

  const retiredRows = db.prepare('SELECT * FROM work_records WHERE finished_at IS NOT NULL OR set_aside_at IS NOT NULL ORDER BY rowid');
  const checkDays = (days: unknown, what: string): number => {
    if (!Number.isSafeInteger(days) || (days as number) < 0) throw invalid(`The ${what} "${String(days)}" isn't a whole number of days from 0.`);
    return days as number;
  };

  const prState = db.prepare(`SELECT state FROM observations WHERE work_id = ? AND observed = 'pr'`);
  /** Each reason the work in `row` isn't complete; none once it is. */
  const incomplete = (row: Row): string[] => {
    if (row.kind === 'slice') return row.finished_at ? [] : ["It isn't finished."];
    if (row.kind === 'decision') {
      const [answer, drafts] = [bodyWritten(row.work_id, 'answer'), bodyWritten(row.work_id, 'domain-drafts')];
      const reasons = [];
      if (answer === undefined) reasons.push("Its confirmed answer isn't recorded.");
      if (drafts === undefined) reasons.push("Its domain drafts aren't recorded.");
      if (reasons.length || !row.parent_id) return reasons;
      const map = bodyWritten(row.parent_id, 'map');
      return map !== undefined && map > Math.max(answer!, drafts!) ? [] : [`Its concept ${row.parent_id}'s map isn't updated since its answer and domain drafts.`];
    }
    if (row.kind === 'concept') {
      const reasons = row.fog_gone_at ? [] : ["Its Fog isn't gone."];
      for (const child of childRows.all(row.work_id) as unknown as Row[]) {
        if (child.set_aside_at || !incomplete(child).length) continue;
        reasons.push(child.kind === 'decision' ? `Its decision ${child.work_id} isn't settled.` : `Its ${child.kind} ${child.work_id} isn't Done.`);
      }
      return reasons;
    }
    const reasons = !row.pull_request ? ['It has no recorded PR.']
      : prState.get(row.work_id)?.state === 'merged' ? [] : [`Its PR ${row.pull_request} isn't observed merged.`];
    return [...reasons, ...unmet(row.work_id).map(({ dependencyId, owner }) => `Its Dependency ${dependencyId} on ${owner} isn't met.`)];
  };

  const related = (query: StatementSync, workId: string): WorkRecord[] => database.read(() => {
    find(workId);
    return (query.all(workId) as unknown as Row[]).map(fromRow);
  });

  return {
    ...publicationRecords(database, (workId) => fromRow(find(workId)), recordDependencyTicket),
    ...dependencyChanges,
    create: (record) => database.write(() => insert(record)),
    read: (workId) => database.read(() => fromRow(find(workId))),
    initialContext: (workId) => database.read(() => find(workId).initial_context),
    list: (filter) => database.read(() => (filtered('SELECT * FROM work_records', 'ORDER BY queue_order IS NULL, queue_order, rowid', [
      ['repository = ?', filter.repository === undefined ? undefined : checkRepository(filter.repository)],
      ['status = ?', filter.status === undefined ? undefined : checkStatus(filter.status)],
      ['kind = ?', filter.kind === undefined ? undefined : checkKind(filter.kind)],
    ]) as unknown as Row[]).map(fromRow)),
    update: (workId, revision, { status, kind }) => {
      const nextStatus = status === undefined ? undefined : checkStatus(status);
      const nextKind = kind === undefined ? undefined : checkKind(kind);
      return change(workId, revision, (row) => {
        if (nextKind && nextKind !== row.kind) {
          const child = { work_id: row.work_id, kind: nextKind };
          if (row.parent_id) checkOwns(find(row.parent_id), child);
          for (const owned of childRows.all(workId) as unknown as Row[]) checkOwns({ ...row, kind: nextKind }, owned);
          // The new kind must hold what the record already holds.
          if (row.build_phase || row.pull_request || row.skills || hasRounds.get(workId)) checkBuilt(nextKind);
          for (const { body } of bodyNames.all(workId)) checkHolds(nextKind, body as Body);
          if (row.fog_gone_at && nextKind !== 'concept') throw invalid(`The concept ${workId} has its Fog recorded gone, so it stays a concept.`);
          const held = kindConflict(workId);
          if (held) throw invalid(held);
        }
        const moved = nextStatus ?? row.status;
        return {
          status: moved,
          kind: nextKind ?? row.kind,
          queue_order: queueOrder(row.repository, moved, moved === row.status ? row.queue_order : null),
        };
      });
    },
    attachTicket: (workId, revision, ticket) => {
      const reference = checkTicket(ticket);
      return change(workId, revision, (row) => {
        if (row.ticket === reference) return null;
        if (row.ticket) throw invalid(`The work record ${workId} already has the ticket ${row.ticket}; it can't take ${reference}.`);
        const holder = byTicket.get(reference) as Row | undefined;
        if (holder) throw new WorkRecordError('ticket-taken', `The work record ${holder.work_id} already holds the ticket ${reference}.`);
        return { ticket: reference };
      });
    },
    importTicket: (record) => database.write(() => {
      const ticket = checkTicket(record.ticket);
      const existing = byTicket.get(ticket) as Row | undefined;
      if (!existing) return { record: insert(record), created: true };
      if (existing.repository !== record.repository) {
        throw new WorkRecordError('ticket-taken', `The ticket ${ticket} already belongs to the work record ${existing.work_id} in ${existing.repository}.`);
      }
      return { record: fromRow(existing), created: false };
    }),
    setAside: (workId, revision) => change(workId, revision, (row) => {
      if (row.set_aside_at) throw invalid(`The work record ${workId} is already set aside.`);
      return { set_aside_at: new Date().toISOString() };
    }),
    restore: (workId, revision) => change(workId, revision, (row) => {
      if (!row.set_aside_at) throw invalid(`The work record ${workId} isn't set aside.`);
      return { set_aside_at: null };
    }),
    setNeedsYou: (workId, revision, reason) => {
      const why = checkFilled(reason, 'Needs you reason');
      return change(workId, revision, (row) => (row.needs_you === why ? null : { needs_you: why }));
    },
    clearNeedsYou: (workId, revision) => change(workId, revision, (row) => (row.needs_you === null ? null : { needs_you: null })),
    snapshotSkills: (workId, revision, skills) => {
      const snapshot = JSON.stringify(checkSkills(skills));
      return change(workId, revision, (row) => {
        checkBuilt(row.kind);
        if (row.skills !== null) throw invalid(`The build ${workId} already snapshotted its skills when it started.`);
        return { skills: snapshot };
      });
    },
    setParent: (workId, revision, parentId) => change(workId, revision, (row, touched) => {
      const parent = find(parentId);
      if (row.parent_id) throw invalid(`The work record ${workId} already has the parent ${row.parent_id}; clear it first.`);
      checkOwns(parent, row);
      const conflict = treeConflict(workId, parentId);
      if (conflict) throw invalid(conflict);
      touched.push(parentId);
      return { parent_id: parentId };
    }),
    clearParent: (workId, revision) => change(workId, revision, (row, touched) => {
      if (!row.parent_id) throw invalid(`The work record ${workId} has no parent.`);
      const conflict = treeConflict(workId, null);
      if (conflict) throw invalid(conflict);
      touched.push(row.parent_id);
      return { parent_id: null };
    }),
    addBlocker: (workId, revision, blockerId) => change(workId, revision, (row, touched) => {
      find(blockerId);
      if (blockerId === workId) throw invalid(`The work record ${workId} can't block itself.`);
      if (hasBlocker.get(workId, blockerId)) throw invalid(`The work record ${workId} is already blocked by ${blockerId}.`);
      if (waitsOn.get(blockerId, workId)) throw invalid(`The work record ${blockerId} already waits on ${workId}, so blocking ${workId} by it would make a cycle.`);
      insertBlocker.run(workId, blockerId);
      touched.push(blockerId);
      return {};
    }),
    removeBlocker: (workId, revision, blockerId) => change(workId, revision, (row, touched) => {
      if (!deleteBlocker.run(workId, blockerId).changes) {
        throw invalid(`The work record ${workId} isn't blocked by ${blockerId}.`);
      }
      touched.push(blockerId);
      return {};
    }),
    setBody: (workId, revision, body, markdown) => {
      const name = checkOneOf(BODIES, body, 'body');
      const text = checkText(markdown, name);
      return change(workId, revision, (row) => {
        checkHolds(row.kind, name);
        writeBody(workId, name, text);
        return {};
      });
    },
    restoreImported: (workId, revision, imported) => {
      const body = checkOneOf(BODIES, imported.body, 'body');
      const markdown = checkText(imported.markdown, body);
      return change(workId, revision, (row, touched) => {
        checkHolds(row.kind, body);
        if (bodyText.get(workId, body)) return null;
        let parentId = row.parent_id;
        if (imported.parentId && !parentId) {
          const parent = find(imported.parentId);
          checkOwns(parent, row);
          parentId = parent.work_id;
          touched.push(parentId);
        }
        for (const blockerId of new Set(imported.blockerIds ?? [])) {
          find(blockerId);
          if (blockerId === workId) throw invalid(`The work record ${workId} can't block itself.`);
          if (hasBlocker.get(workId, blockerId)) continue;
          if (waitsOn.get(blockerId, workId)) throw invalid(`The work record ${blockerId} already waits on ${workId}, so blocking ${workId} by it would make a cycle.`);
          insertBlocker.run(workId, blockerId);
          if (!touched.includes(blockerId)) touched.push(blockerId);
        }
        writeBody(workId, body, markdown);
        return { parent_id: parentId };
      });
    },
    body: (workId, body) => database.read(() => {
      const name = checkOneOf(BODIES, body, 'body');
      find(workId);
      const row = bodyText.get(workId, name);
      return row ? String(row.markdown) : null;
    }),
    setBuildPhase: (workId, revision, phase) => {
      const checked = checkOneOf(BUILD_PHASES, phase, 'build phase');
      return change(workId, revision, (row) => (checkBuilt(row.kind), { build_phase: checked }));
    },
    setPullRequest: (workId, revision, pullRequest) => {
      const reference = checkReference(pullRequest, 'PR');
      return change(workId, revision, (row) => {
        checkBuilt(row.kind);
        if (row.pull_request === reference) return null;
        if (row.pull_request) replacePullRequest.run(workId, row.pull_request, new Date().toISOString());
        deleteObservation.run(workId, 'pr');
        return { pull_request: reference };
      });
    },
    observe: (workId, revision, observation) => {
      const of = checkOneOf(OBSERVED, observation?.of, 'observed thing');
      const state = of === 'ticket' ? checkOneOf(TICKET_STATES, observation.state, 'ticket state') : checkOneOf(PULL_REQUEST_STATES, observation.state, 'PR state');
      const { assignee } = observation as { assignee?: unknown };
      if (of === 'pr' && assignee !== undefined) throw invalid('A PR observation has no assignee.');
      const who = assignee === undefined ? null : checkFilled(assignee, 'assignee');
      return change(workId, revision, (row) => {
        const now = new Date().toISOString();
        writeObservation.run(workId, of, subject(row, of), state, who, now);
        return state === 'merged' && !row.finished_at ? { finished_at: now } : {};
      });
    },
    recordReadFailure: (workId, revision, of, failure) => {
      const observed = checkOneOf(OBSERVED, of, 'observed thing');
      const reason = checkFilled(failure, 'read failure');
      return change(workId, revision, (row) => (writeReadFailure.run(workId, observed, subject(row, observed), new Date().toISOString(), reason), {}));
    },
    observations: (workId) => database.read(() => {
      find(workId);
      return observationRows.all(workId).map((row): Observation => ({
        of: row.observed as Observed,
        subject: String(row.subject),
        state: row.state as Observation['state'],
        assignee: row.assignee as string | null,
        observedAt: row.observed_at as string | null,
        failedAt: row.failed_at as string | null,
        failure: row.failure as string | null,
      }));
    }),
    replacedPullRequests: (workId) => database.read(() => {
      find(workId);
      return replacedRows.all(workId).map((row) => ({ pullRequest: String(row.pull_request), replacedAt: String(row.replaced_at) }));
    }),
    recordReviewRound: (workId, revision, round) => change(workId, revision, (row) => {
      checkBuilt(row.kind);
      if (typeof round?.base !== 'string' || !/^[0-9a-f]{7,64}$/.test(round.base)) throw invalid(`The round's base "${String(round?.base)}" isn't a commit sha.`);
      if (!Array.isArray(round.reviewers as unknown) || !round.reviewers.length) throw invalid('The round has no reviewers.');
      const number = Number(nextRound.get(workId)!.next);
      insertRound.run(workId, number, round.base, new Date().toISOString());
      const seen = new Set<ReviewAxis>();
      for (const reviewer of round.reviewers) {
        const axis = checkOneOf(REVIEW_AXES, reviewer?.axis, 'axis');
        if (seen.has(axis)) throw invalid(`The round lists the ${axis} reviewer twice.`);
        seen.add(axis);
        const verdict = checkOneOf(REVIEW_VERDICTS, reviewer.verdict, 'verdict');
        const notChecked = verdict === 'skipped' ? checkFilled(reviewer.notChecked, `reason the ${axis} reviewer was skipped`)
          : reviewer.notChecked === undefined ? null : checkFilled(reviewer.notChecked, `${axis} reviewer's note on what it couldn't check`);
        if (!Array.isArray(reviewer.findings as unknown)) throw invalid(`The ${axis} reviewer's findings aren't a list.`);
        if (verdict === 'skipped' && reviewer.findings.length) throw invalid(`The skipped ${axis} reviewer can't have findings.`);
        insertAxis.run(workId, number, axis, verdict, notChecked);
        reviewer.findings.forEach((finding, index) => {
          const severity = checkOneOf(FINDING_SEVERITIES, finding?.severity, 'severity');
          const summary = checkFilled(finding.summary, `${axis} finding`);
          const [disposition, reason] = checkDisposition(finding.disposition, finding.reason);
          insertFinding.run(workId, number, axis, index + 1, severity, summary, disposition, reason);
        });
      }
      return {};
    }),
    setFindingDisposition: (workId, revision, { round, axis, finding }, disposition, reason) => {
      const [checked, why] = checkDisposition(disposition, reason);
      return change(workId, revision, () => {
        const updated = disposeFinding.run(checked, why, workId, round, axis, finding);
        if (!updated.changes) throw new WorkRecordError('not-found', `The work record ${workId} has no finding ${finding} from the ${axis} reviewer in round ${round}.`);
        return {};
      });
    },
    reviewRounds: (workId) => database.read(() => {
      find(workId);
      return roundRows.all(workId).map((round): ReviewRound => ({
        round: Number(round.round),
        base: String(round.base),
        recordedAt: String(round.recorded_at),
        reviewers: axisRows.all(workId, Number(round.round)).map((axis): AxisReview => ({
          axis: axis.axis as ReviewAxis,
          verdict: axis.verdict as ReviewVerdict,
          notChecked: axis.not_checked as string | null,
          findings: findingRows.all(workId, Number(round.round), String(axis.axis)).map((finding): ReviewFinding => ({
            severity: finding.severity as FindingSeverity,
            summary: String(finding.summary),
            disposition: finding.disposition as FindingDisposition,
            reason: finding.reason as string | null,
          })),
        })),
      }));
    }),
    addThread: (workId, revision, threadId, purpose) => {
      const id = checkThreadId(threadId);
      const checked = checkPurpose(purpose);
      return change(workId, revision, () => (insertThread(workId, id, checked), {}));
    },
    threads: (workId) => database.read(() => {
      find(workId);
      return threadRows.all(workId)
        .map((row) => ({ threadId: String(row.thread_id), purpose: String(row.purpose), recordedAt: String(row.recorded_at) }));
    }),
    recordLaunchIntent: (workId, revision, purpose) => {
      const checked = checkPurpose(purpose);
      const intentId = randomUUID();
      const record = change(workId, revision, () => {
        insertIntent.run(intentId, workId, checked, new Date().toISOString());
        return {};
      });
      return { record, intent: intent(intentId) };
    },
    launchIntents: (filter) => database.read(() => (filtered('SELECT i.* FROM launch_intents i JOIN work_records r ON r.work_id = i.work_id', 'ORDER BY i.rowid', [
      ['r.repository = ?', filter.repository === undefined ? undefined : checkRepository(filter.repository)],
      ['i.work_id = ?', filter.workId],
      ['i.resolved_at IS NULL', filter.unresolved || undefined],
    ]) as unknown as IntentRow[]).map(fromIntentRow)),
    resolveLaunchIntent: (workId, revision, intentId, outcome) => {
      const threadId = 'threadId' in outcome ? checkThreadId(outcome.threadId) : null;
      const failure = threadId === null ? checkFilled((outcome as { failure: unknown }).failure, 'launch failure') : null;
      const record = change(workId, revision, () => {
        const row = selectIntent.get(intentId) as IntentRow | undefined;
        if (row?.work_id !== workId) throw new WorkRecordError('not-found', `The work record ${workId} has no launch intent "${intentId}".`);
        if (row.resolved_at) throw invalid(`The launch intent ${intentId} is already resolved.`);
        if (threadId) insertThread(workId, threadId, row.purpose);
        resolveIntent.run(threadId, failure, new Date().toISOString(), intentId);
        return {};
      });
      return { record, intent: intent(intentId) };
    },
    recordFinished: (workId, revision) => change(workId, revision, (row) => {
      if (row.finished_at) throw invalid(`The work record ${workId} is already finished.`);
      return { finished_at: new Date().toISOString() };
    }),
    hidden: (retention, now = new Date()) => {
      const days = checkDays(retention?.hideAfterDays, 'days before hiding');
      return database.read(() => dueRows(retiredRows.all() as unknown as Row[], days, now).map(fromRow));
    },
    deleteExpired: (retention, now = new Date()) => {
      if (retention?.deleteAfterDays === null) return { deleted: [], kept: [] };
      const days = checkDays(retention?.deleteAfterDays, 'days before deleting');
      return database.write(() => {
        const due = new Map(dueRows(retiredRows.all() as unknown as Row[], days, now).map((row) => [row.work_id, row]));
        const kept: Expired['kept'] = [];
        const journals = db.prepare('SELECT plan_id, work_id, content, superseded_by FROM publication_plans').all();
        const publicationSources = db.prepare('SELECT work_id FROM publication_sources WHERE plan_id = ?');
        const unresolved = (planId: string, content: string): boolean => {
          const operations = (JSON.parse(content) as { operations: { operationId: string }[] }).operations;
          const attempts = new Map(db.prepare('SELECT operation_id, attempt FROM publication_outcomes WHERE plan_id = ?').all(planId)
            .map((row) => [String(row.operation_id), (JSON.parse(String(row.attempt)) as { status: string }).status]));
          return operations.some((operation) => attempts.get(operation.operationId) !== 'successful');
        };
        // A due record that a kept record needs is kept too, which can keep its own parent or blockers in turn.
        for (let changed = true; changed;) {
          changed = false;
          for (const [workId] of due) {
            const child = (childRows.all(workId) as unknown as Row[]).find((row) => !due.has(row.work_id));
            const waiting = child ? undefined : (dependentRows.all(workId) as unknown as Row[]).find((row) => !due.has(row.work_id));
            const journal = journals.find((plan) => {
              const members = [String(plan.work_id), ...publicationSources.all(String(plan.plan_id)).map((source) => String(source.work_id))];
              return members.includes(workId) && (members.some((id) => !due.has(id)) ||
                (plan.superseded_by === null && unresolved(String(plan.plan_id), String(plan.content))));
            });
            const dependency = retentionReason(workId, (id) => due.has(id));
            if (!child && !waiting && !journal && !dependency) continue;
            due.delete(workId);
            kept.push({ workId, reason: dependency ?? (journal ? `Its publication journal still needs recovery evidence or a kept source.` : child ? `It owns the ${child.kind} ${child.work_id}, which is kept.` : `The ${waiting!.kind} ${waiting!.work_id}, which is kept, waits on it.`) });
            changed = true;
          }
        }
        const deleted = [...due.keys()];
        const touched = new Set<string>();
        for (const workId of deleted) {
          const { parent_id: parent } = due.get(workId)!;
          if (parent && !due.has(parent)) touched.add(parent);
          for (const blocker of blockerRows.all(workId) as unknown as Row[]) if (!due.has(blocker.work_id)) touched.add(blocker.work_id);
        }
        // Children go before their parents, so clear the parents among the deleted records first.
        const deleteOwned = ['review_findings', 'review_axes', 'review_rounds', 'bodies', 'threads', 'launch_intents', 'replaced_pull_requests', 'observations', 'brief_gates']
          .map((table) => db.prepare(`DELETE FROM ${table} WHERE work_id = ?`));
        const clearParent = db.prepare('UPDATE work_records SET parent_id = NULL WHERE work_id = ?');
        const deleteBlockers = db.prepare('DELETE FROM blockers WHERE work_id = ? OR blocker_id = ?');
        const deleteRecord = db.prepare('DELETE FROM work_records WHERE work_id = ?');
        for (const workId of deleted) clearParent.run(workId);
        for (const workId of deleted) db.prepare('DELETE FROM publication_attachments WHERE work_id = ?').run(workId);
        for (const workId of deleted) db.prepare('DELETE FROM publication_plans WHERE work_id = ?').run(workId);
        for (const workId of deleted) {
          for (const holder of forgetDependencies(database, workId)) if (!due.has(holder)) touched.add(holder);
          for (const statement of deleteOwned) statement.run(workId);
          deleteBlockers.run(workId, workId);
          deleteRecord.run(workId);
        }
        const at = new Date().toISOString();
        for (const workId of touched) bump.run(at, workId);
        return { deleted, kept };
      });
    },
    completion: (workId) => database.read(() => {
      const reasons = incomplete(find(workId));
      return { complete: !reasons.length, reasons };
    }),
    waitingOn: (workId) => database.read(() => {
      find(workId);
      const records = (blockerRows.all(workId) as unknown as Row[])
        .map((blocker) => ({ workId: blocker.work_id, reasons: incomplete(blocker) }))
        .filter((blocker) => blocker.reasons.length);
      return [...records, ...unmet(workId).map(({ dependencyId }) => ({ dependencyId, reasons: ["It isn't marked met."] }))];
    }),
    setFogGone: (workId, revision, gone) => {
      if (typeof gone !== 'boolean') throw invalid(`Whether the Fog is gone "${String(gone)}" isn't true or false.`);
      return change(workId, revision, (row) => {
        if (row.kind !== 'concept') throw invalid(`Only a concept has Fog; this record is a ${row.kind}.`);
        if ((row.fog_gone_at !== null) === gone) return null;
        return { fog_gone_at: gone ? new Date().toISOString() : null };
      });
    },
    children: (workId) => related(childRows, workId),
    blockers: (workId) => related(blockerRows, workId),
    dependents: (workId) => related(dependentRows, workId),
    close: () => database.close(),
  };
}
