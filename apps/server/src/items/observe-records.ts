// The provider reads that keep each work record's observations: its current PR's state, then its ticket's state and
// assignees. A change the record didn't make waits on the user through Needs you and never moves the Status, except a
// merged PR, which finishes the work and makes it Done. A failed read keeps the last observation and changes nothing.
// A decision or concept finishes from its record alone, once lar-work completion says it is complete.
// A record's Dependencies are read the same way, their tickets and PRs only, and what a read shows never marks one met
// or clears its mark.

import { sameRepo } from '@lar-factory/shared';
import type { DependencyObservationKind, NewObservation, Observation, Observed, PullRequestState, WorkRecord, WorkRecords } from '@lar-factory/work-records';
import { log } from '../log.ts';
import { AccessLost, NotFound, type TicketObservation } from './item-source.ts';

/**
 * The provider reads an observation takes, each throwing when the provider can't answer: NotFound when it says the PR
 * doesn't exist, AccessLost when it refuses the signed-in account.
 */
export interface ObserveReads {
  ticket(repo: string, number: number): Promise<TicketObservation>;
  pr(repo: string, number: number): Promise<PullRequestState>;
  /** The ticket as the item source's last read showed it, which saves its read; undefined when that read didn't show it. */
  known?(repo: string, number: number): TicketObservation | undefined;
  /** Whether reads of `repo` wait for now, so a Dependency's ticket or PR there keeps its last observation. */
  waits?(repo: string): boolean;
}

/** How many records' provider reads run at once. */
const OBSERVED_AT_ONCE = 6;

/** The number in a reference, `owner/name#12`. */
const numberOf = (reference: string) => Number(reference.slice(reference.lastIndexOf('#') + 1));

/** Why the observation `next` waits on the user, given the record before it and the last one of its kind; null when nothing does. */
function needsYouOf(record: WorkRecord, previous: Observation | undefined, next: NewObservation): string | null {
  const was = previous?.state ?? null;
  if (next.of === 'pr') {
    return next.state === 'closed' && was !== 'closed'
      ? `Its PR ${record.pullRequest} closed without merging. Reopen it, start a replacement build from the same brief, or set the work aside.` : null;
  }
  const ticket = record.ticket!;
  if (next.state === 'not-found') {
    return `Its ticket ${ticket} wasn't found in its provider, so the board set the work aside. Restore it from Settings › Archive once the ticket is back.`;
  }
  const done = record.status === 'Done' || record.finishedAt !== null;
  if (next.state === 'closed' && was !== 'closed' && !done) return `Its ticket ${ticket} closed in its provider. Set the work aside, or clear this to keep working.`;
  if (next.state === 'open' && was === 'closed' && record.status === 'Done') return `Its ticket ${ticket} reopened after the work was Done. Reopen the work, or clear this.`;
  const assignee = next.assignee ?? null;
  if (was !== null && was !== 'not-found' && previous!.assignee !== assignee) {
    return `Its ticket ${ticket} moved from ${previous!.assignee ?? 'no one'} to ${assignee ?? 'no one'}. Check who owns the work, then clear this.`;
  }
  return null;
}

/** Reads the record's `of` and records what it shows, with what the change means for the work. */
async function observeOne(records: WorkRecords, workId: string, of: Observed, read: () => Promise<NewObservation>): Promise<void> {
  const previous = records.observations(workId).find((o) => o.of === of);
  const reference = of === 'ticket' ? records.read(workId).ticket : records.read(workId).pullRequest;
  let next: NewObservation;
  try { next = await read(); }
  catch (err) {
    records.recordReadFailure(workId, records.read(workId).revision, of, err instanceof Error ? err.message : String(err));
    return;
  }
  const before = records.read(workId);
  // A PR replaced during the read was not the one it read.
  if ((of === 'ticket' ? before.ticket : before.pullRequest) !== reference) return;
  const reason = needsYouOf(before, previous, next);
  let record = records.observe(workId, before.revision, next);
  if (next.of === 'pr' && next.state === 'merged' && record.status !== 'Done') record = records.update(workId, record.revision, { status: 'Done' });
  if (next.of === 'ticket' && next.state === 'not-found') record = records.setAside(workId, record.revision);
  if (reason) records.setNeedsYou(workId, record.revision, reason);
}

/** The kinds a ticket or PR read open again was last read as, which make it reopened. */
const ENDED: readonly (DependencyObservationKind | undefined)[] = ['closed', 'merged', 'reopened'];

/** Reads the Dependency's ticket or PR `subject` and records what it shows, beside the last read that answered when it fails. */
async function observeDependency(records: WorkRecords, dependencyId: string, subject: string, read: () => Promise<TicketObservation['state'] | PullRequestState>): Promise<void> {
  let kind: DependencyObservationKind;
  let detail: string | undefined;
  try {
    const state = await read();
    kind = state === 'not-found' ? 'deleted' : state;
  } catch (err) {
    kind = err instanceof NotFound ? 'deleted' : err instanceof AccessLost ? 'access-lost' : 'read-failed';
    detail = (err instanceof Error ? err.message : String(err)) || undefined;
  }
  const dependency = records.dependency(dependencyId);
  // A ticket or PR the Dependency stopped naming during the read was not one it reads.
  if (subject !== dependency.ticket && !dependency.pullRequests.includes(subject)) return;
  const last = dependency.observations.find((o) => o.subject === subject);
  if (kind === 'open' && ENDED.includes(last?.lastGood?.kind ?? last?.kind)) kind = 'reopened';
  records.observeDependency(dependencyId, dependency.revision, { subject, kind, ...detail && { detail } });
}

/**
 * Observes every active record of `repos`, less the work IDs in `hidden`, which retention hides: its current PR until
 * the work finishes, then its ticket, PR first so a merge that closes the ticket finishes the work before the ticket's
 * close is seen, then its Dependencies' tickets and PRs, each once a pass, OBSERVED_AT_ONCE records at a time. `changed` publishes each observation's writes before another
 * provider read can hold up the pass. A record a thread changes meanwhile is read again next time.
 */
export async function observeRecords(records: WorkRecords, repos: readonly string[], reads: ObserveReads, hidden: ReadonlySet<string> = new Set(),
  changed: () => void = () => {}): Promise<void> {
  const active = records.list({}).filter((r) => !r.setAside && !hidden.has(r.workId) && repos.some((repo) => sameRepo(repo, r.repository)));
  // Each Dependency ticket or PR reads once a pass, however many Dependencies name it.
  const subjectReads = new Map<string, Promise<TicketObservation['state'] | PullRequestState>>();
  const readSubject = (subject: string, ticket: boolean) => {
    const key = `${ticket ? 'ticket' : 'pr'}:${subject.toLowerCase()}`;
    if (!subjectReads.has(key)) {
      const repo = subject.slice(0, subject.lastIndexOf('#'));
      const number = numberOf(subject);
      subjectReads.set(key, ticket ? (async () => (reads.known?.(repo, number) ?? await reads.ticket(repo, number)).state)() : reads.pr(repo, number));
    }
    return subjectReads.get(key)!;
  };
  let next = 0;
  const observeNext = async (): Promise<void> => {
    for (; next < active.length;) await observeActive(active[next++]!);
  };
  const observeActive = async ({ workId, repository, ticket, pullRequest, finishedAt }: WorkRecord): Promise<void> => {
    try {
      if (pullRequest && !finishedAt) {
        await observeOne(records, workId, 'pr', async () => ({ of: 'pr', state: await reads.pr(repository, numberOf(pullRequest)) })).finally(changed);
      }
      if (ticket && !records.read(workId).setAside) {
        const number = numberOf(ticket);
        await observeOne(records, workId, 'ticket', async () => ({ of: 'ticket', ...reads.known?.(repository, number) ?? await reads.ticket(repository, number) })).finally(changed);
      }
      for (const { dependencyId, ticket: theirs, pullRequests } of records.dependencies(workId)) {
        for (const subject of [...theirs ? [theirs] : [], ...pullRequests]) {
          const repo = subject.slice(0, subject.lastIndexOf('#'));
          if (reads.waits?.(repo)) continue;
          await observeDependency(records, dependencyId, subject, () => readSubject(subject, subject === theirs)).finally(changed);
        }
      }
    } catch (err) {
      log(`can't record what ${workId}'s provider shows: ${(err as Error).message}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(OBSERVED_AT_ONCE, active.length) }, observeNext));
}

/**
 * Finishes each active decision and concept of `repos` that lar-work completion says is complete, making it Done. A
 * build finishes only when its PR is observed merged, so its completion alone changes nothing here.
 */
export function finishCompleted(records: WorkRecords, repos: readonly string[]): void {
  for (const record of records.list({})) {
    if (record.setAside || record.finishedAt || (record.kind !== 'decision' && record.kind !== 'concept')) continue;
    if (!repos.some((repo) => sameRepo(repo, record.repository)) || !records.completion(record.workId).complete) continue;
    try {
      const done = record.status === 'Done' ? record : records.update(record.workId, record.revision, { status: 'Done' });
      records.recordFinished(record.workId, done.revision);
    } catch (err) {
      log(`can't finish ${record.workId}: ${(err as Error).message}`);
    }
  }
}
