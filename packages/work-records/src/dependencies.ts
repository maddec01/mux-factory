// Dependencies: changes a work record needs in a repository the user doesn't work on, delivered by the team that owns
// it. A Dependency lives inside one work record and holds the builds it blocks until the user marks it met. Provider
// reads of its ticket and PRs are kept beside it; a read never sets or clears the mark, and never deletes the
// Dependency or its handover.

import { randomUUID } from 'node:crypto';
import { DEPENDENCY_OBSERVATION_KINDS, type DependencyObservationKind } from '@lar-factory/shared';
import { WorkRecordError, type Database } from './database.ts';

export { DEPENDENCY_OBSERVATION_KINDS, type DependencyObservationKind };

interface DependencyObservation {
  /** The ticket or PR read, `owner/name#12`. */
  subject: string;
  kind: DependencyObservationKind;
  /** What the provider said, such as why a read failed; null when it said nothing more. */
  detail: string | null;
  observedAt: string;
  /** The last read that answered, kept beside a read that failed or lost access; null after a read that answered. */
  lastGood: { kind: DependencyObservationKind; observedAt: string } | null;
}

/** The kinds of a read that didn't answer, which keep the last read that did. */
const FAILED_READS: readonly DependencyObservationKind[] = ['access-lost', 'read-failed'];

export interface Dependency {
  dependencyId: string;
  /** The work record it lives in. */
  workId: string;
  /** What is needed and why. */
  need: string;
  /** The repository or team that owns and delivers the change. */
  owner: string;
  /** The contract agreed with the owner; empty until agreed. */
  contract: string;
  /** What will establish that the change was delivered; empty until agreed. */
  evidence: string;
  ticket: string | null;
  pullRequests: string[];
  /** Markdown for the owning team. */
  handover: string;
  /** Who marked it met and when, or null while unmet. Only the user sets or clears it. */
  met: { by: string; at: string } | null;
  /** Whether an observation changed after it was marked met. The mark stays until the user acts. */
  needsReview: boolean;
  /** The builds it holds, in the order they were added. */
  blocks: string[];
  /** The build its dependents now wait on instead, or null while it wasn't replaced. */
  replacedBy: string | null;
  /** The latest read of its ticket, then each PR it was read for. */
  observations: DependencyObservation[];
  /** Counts the Dependency's changes; every change names the revision it read. */
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface NewDependency {
  need: string;
  owner: string;
  contract?: string;
  evidence?: string;
  ticket?: string;
  pullRequests?: readonly string[];
  handover?: string;
}

/** The fields to change; a null ticket removes it. Observations of a ticket or PR it no longer names are dropped. */
export type DependencyChange = Partial<Omit<NewDependency, 'ticket'>> & { ticket?: string | null };

interface NewDependencyObservation {
  subject: string;
  kind: DependencyObservationKind;
  detail?: string;
}

export interface DependencyRecords {
  /** Adds a Dependency to the work record, bumping the record. */
  addDependency(workId: string, dependency: NewDependency): Dependency;
  /** Throws `not-found` when no Dependency has `dependencyId`. */
  dependency(dependencyId: string): Dependency;
  /** The Dependencies the record holds, in the order they were added. */
  dependencies(workId: string): Dependency[];
  /** The Dependencies holding the build, met or not, in the order they were added to it. */
  blockingDependencies(buildId: string): Dependency[];
  /** The unmet Dependencies holding the build. */
  unmetDependencies(buildId: string): Dependency[];
  updateDependency(dependencyId: string, revision: number, change: DependencyChange): Dependency;
  /** Records that the Dependency holds `buildId`, a build in the same work tree. Bumps the build. */
  addDependencyBlock(dependencyId: string, revision: number, buildId: string): Dependency;
  removeDependencyBlock(dependencyId: string, revision: number, buildId: string): Dependency;
  /** Records the latest read of its ticket or one of its PRs, replacing the last read of that subject but keeping the last
   * read that answered beside a failed one. Never changes the met mark; flags a met Dependency for review when the kind
   * changed from the last one that wasn't a temporary read failure, which an outage or a subject's first read never is. */
  observeDependency(dependencyId: string, revision: number, observation: NewDependencyObservation): Dependency;
  /** Records the user's decision that it is met, clearing any review flag. */
  markDependencyMet(dependencyId: string, revision: number, by: string): Dependency;
  clearDependencyMet(dependencyId: string, revision: number): Dependency;
  /** Makes every build it holds wait on `buildId` instead, whole or not at all. The Dependency and its mark stay. */
  replaceDependencyWithBuild(dependencyId: string, revision: number, buildId: string): Dependency;
}

interface Row {
  dependency_id: string;
  work_id: string;
  need: string;
  owner: string;
  contract: string;
  evidence: string;
  ticket: string | null;
  pull_requests: string;
  handover: string;
  met_by: string | null;
  met_at: string | null;
  needs_review_at: string | null;
  replaced_by: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface RecordRow {
  work_id: string;
  kind: string;
  parent_id: string | null;
}

const invalid = (message: string) => new WorkRecordError('invalid', message);

function checkFilled(text: unknown, what: string): string {
  if (typeof text !== 'string' || !text.trim()) throw invalid(`The Dependency's ${what} is empty or isn't text.`);
  return text;
}

function checkText(text: unknown, what: string): string {
  if (typeof text !== 'string') throw invalid(`The Dependency's ${what} isn't text.`);
  return text;
}

function checkReference(reference: unknown, what: string): string {
  if (typeof reference !== 'string' || !/^[^\s/#]+(\/[^\s/#]+)+#[1-9]\d*$/.test(reference)) {
    throw invalid(`The ${what} "${String(reference)}" isn't a reference like owner/name#12.`);
  }
  return reference;
}

function checkPullRequests(pullRequests: unknown): string[] {
  if (!Array.isArray(pullRequests)) throw invalid("The Dependency's PRs aren't a list.");
  const checked = pullRequests.map((pr) => checkReference(pr, 'PR'));
  if (new Set(checked).size !== checked.length) throw invalid("The Dependency's PRs list one PR twice.");
  return checked;
}

function checkRevision(revision: unknown): number {
  if (!Number.isSafeInteger(revision) || (revision as number) < 1) throw invalid(`The revision "${String(revision)}" isn't a whole number from 1.`);
  return revision as number;
}

/** Deletes, inside the caller's write, the Dependencies `workId` holds with their blocks and reads, and drops it from any
 * other Dependency's blocks, bumping that Dependency. Returns the records holding those other Dependencies. */
export function forgetDependencies({ db }: Database, workId: string): string[] {
  for (const table of ['dependency_observations', 'dependency_blocks', 'dependencies']) {
    db.prepare(`DELETE FROM ${table} WHERE dependency_id IN (SELECT dependency_id FROM dependencies WHERE work_id = ?)`).run(workId);
  }
  const holders = db.prepare(`SELECT DISTINCT d.work_id FROM dependency_blocks b JOIN dependencies d ON d.dependency_id = b.dependency_id
    WHERE b.build_id = ?`).all(workId).map((row) => String(row.work_id));
  db.prepare(`UPDATE dependencies SET revision = revision + 1, updated_at = ? WHERE dependency_id IN
    (SELECT dependency_id FROM dependency_blocks WHERE build_id = ?)`).run(new Date().toISOString(), workId);
  db.prepare('DELETE FROM dependency_blocks WHERE build_id = ?').run(workId);
  return holders;
}

/** The Dependencies kept in `database`. `bump` bumps a work record's revision, as every relationship change does. */
export function dependencyRecords(database: Database, bump: (workId: string) => void): DependencyRecords & {
  /** Why moving `workId` under `parentId` (null to clear it) would leave a Dependency blocking a build outside its work tree; null when it wouldn't. */
  treeConflict(workId: string, parentId: string | null): string | null;
  /** Why a build couldn't become another kind; null when no Dependency blocks it. */
  kindConflict(buildId: string): string | null;
  /** Why retention keeps the due record: it holds an unmet Dependency or one blocking a record that isn't due, or an
   * unmet Dependency blocks it. Null when no Dependency needs it. */
  retentionReason(workId: string, due: (workId: string) => boolean): string | null;
  /** Records the ticket that received the Dependency's request, inside the caller's write. Bumps it and its holder. */
  recordDependencyTicket(dependencyId: string, ticket: string): void;
} {
  const { db } = database;
  const select = db.prepare('SELECT * FROM dependencies WHERE dependency_id = ?');
  const ownedRows = db.prepare('SELECT * FROM dependencies WHERE work_id = ? ORDER BY rowid');
  const blockingRows = db.prepare(`SELECT d.* FROM dependency_blocks b JOIN dependencies d ON d.dependency_id = b.dependency_id
    WHERE b.build_id = ? ORDER BY b.rowid`);
  const unmetRows = db.prepare(`SELECT d.* FROM dependency_blocks b JOIN dependencies d ON d.dependency_id = b.dependency_id
    WHERE b.build_id = ? AND d.met_at IS NULL ORDER BY b.rowid`);
  const blockingRow = db.prepare('SELECT dependency_id FROM dependency_blocks WHERE build_id = ? ORDER BY rowid LIMIT 1');
  const allBlocks = db.prepare('SELECT b.build_id, d.dependency_id, d.work_id FROM dependency_blocks b JOIN dependencies d ON d.dependency_id = b.dependency_id');
  const blockRows = db.prepare('SELECT build_id FROM dependency_blocks WHERE dependency_id = ? ORDER BY rowid');
  const insertBlock = db.prepare('INSERT INTO dependency_blocks (dependency_id, build_id) VALUES (?, ?)');
  const deleteBlock = db.prepare('DELETE FROM dependency_blocks WHERE dependency_id = ? AND build_id = ?');
  const deleteBlocks = db.prepare('DELETE FROM dependency_blocks WHERE dependency_id = ?');
  const observationRows = db.prepare('SELECT * FROM dependency_observations WHERE dependency_id = ? ORDER BY subject <> ?, rowid');
  const observationRow = db.prepare('SELECT * FROM dependency_observations WHERE dependency_id = ? AND subject = ?');
  const writeObservation = db.prepare(`INSERT INTO dependency_observations (dependency_id, subject, kind, detail, observed_at, last_good_kind, last_good_at)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO UPDATE SET kind = excluded.kind, detail = excluded.detail, observed_at = excluded.observed_at,
    last_good_kind = excluded.last_good_kind, last_good_at = excluded.last_good_at`);
  const deleteObservation = db.prepare('DELETE FROM dependency_observations WHERE dependency_id = ? AND subject = ?');
  const insertRow = db.prepare(`INSERT INTO dependencies (dependency_id, work_id, need, owner, contract, evidence, ticket, pull_requests, handover,
    revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`);
  const updateRow = db.prepare(`UPDATE dependencies SET need = ?, owner = ?, contract = ?, evidence = ?, ticket = ?, pull_requests = ?, handover = ?,
    met_by = ?, met_at = ?, needs_review_at = ?, replaced_by = ?, revision = ?, updated_at = ? WHERE dependency_id = ? AND revision = ?`);
  const selectRecord = db.prepare('SELECT work_id, kind, parent_id FROM work_records WHERE work_id = ?');
  const hasBlocker = db.prepare('SELECT 1 FROM blockers WHERE work_id = ? AND blocker_id = ?');
  const insertBlocker = db.prepare('INSERT INTO blockers (work_id, blocker_id) VALUES (?, ?)');
  const waitsOn = db.prepare(`WITH RECURSIVE waiting (id) AS (SELECT ? UNION SELECT b.blocker_id FROM blockers b JOIN waiting ON b.work_id = waiting.id)
    SELECT 1 FROM waiting WHERE id = ?`);

  const findRecord = (workId: string): RecordRow => {
    const row = selectRecord.get(workId) as RecordRow | undefined;
    if (!row) throw new WorkRecordError('not-found', `No work record has the work ID "${workId}".`);
    return row;
  };
  const find = (dependencyId: string): Row => {
    const row = select.get(dependencyId) as Row | undefined;
    if (!row) throw new WorkRecordError('not-found', `No Dependency has the ID "${dependencyId}".`);
    return row;
  };
  /** The work tree's root: the record's topmost parent, reading `moved` as under its given parent. */
  const root = (workId: string, moved?: { workId: string; parentId: string | null }): string => {
    for (let id = workId; ;) {
      const parent = moved?.workId === id ? moved.parentId : findRecord(id).parent_id;
      if (!parent) return id;
      id = parent;
    }
  };
  const fromRow = (row: Row): Dependency => ({
    dependencyId: row.dependency_id,
    workId: row.work_id,
    need: row.need,
    owner: row.owner,
    contract: row.contract,
    evidence: row.evidence,
    ticket: row.ticket,
    pullRequests: JSON.parse(row.pull_requests) as string[],
    handover: row.handover,
    met: row.met_at ? { by: row.met_by!, at: row.met_at } : null,
    needsReview: row.needs_review_at !== null,
    blocks: blockRows.all(row.dependency_id).map((block) => String(block.build_id)),
    replacedBy: row.replaced_by,
    observations: observationRows.all(row.dependency_id, row.ticket ?? '').map((observation): DependencyObservation => ({
      subject: String(observation.subject),
      kind: observation.kind as DependencyObservationKind,
      detail: observation.detail as string | null,
      observedAt: String(observation.observed_at),
      lastGood: observation.last_good_kind
        ? { kind: observation.last_good_kind as DependencyObservationKind, observedAt: String(observation.last_good_at) } : null,
    })),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

  /** Writes `patch` over `row`, bumping it. */
  const save = (row: Row, patch: Partial<Row>) => {
    const next = { ...row, ...patch, revision: row.revision + 1, updated_at: new Date().toISOString() };
    updateRow.run(next.need, next.owner, next.contract, next.evidence, next.ticket, next.pull_requests, next.handover, next.met_by, next.met_at,
      next.needs_review_at, next.replaced_by, next.revision, next.updated_at, row.dependency_id, row.revision);
  };
  /** Applies `apply` to the Dependency at `revision`, bumping it; throws when it moved on. */
  const change = (dependencyId: string, revision: number, apply: (row: Row) => Partial<Row>): Dependency => database.write(() => {
    const expected = checkRevision(revision);
    const row = find(dependencyId);
    if (row.revision !== expected) {
      throw new WorkRecordError('stale-revision', `The Dependency ${dependencyId} is at revision ${row.revision}, not ${expected}; read it again and retry.`);
    }
    save(row, apply(row));
    return fromRow(find(dependencyId));
  });
  /** Drops the observations of a ticket or PR that `row` with `patch` no longer names, and returns `patch`. */
  const keepNamed = (row: Row, patch: Partial<Row>): Partial<Row> => {
    const next = { ...row, ...patch };
    const named = new Set([next.ticket, ...JSON.parse(next.pull_requests) as string[]]);
    for (const observation of observationRows.all(row.dependency_id, '')) {
      if (!named.has(String(observation.subject))) deleteObservation.run(row.dependency_id, String(observation.subject));
    }
    return patch;
  };
  /** The build `buildId`, checked to be a build. */
  const findBuild = (buildId: string): RecordRow => {
    const build = findRecord(buildId);
    if (build.kind !== 'build') throw invalid(`A Dependency blocks only builds, and ${buildId} is a ${build.kind}.`);
    return build;
  };

  return {
    addDependency: (workId, dependency) => {
      const need = checkFilled(dependency?.need, 'need');
      const owner = checkFilled(dependency.owner, 'owner');
      const contract = checkText(dependency.contract ?? '', 'contract');
      const evidence = checkText(dependency.evidence ?? '', 'evidence');
      const ticket = dependency.ticket === undefined ? null : checkReference(dependency.ticket, 'ticket');
      const pullRequests = checkPullRequests(dependency.pullRequests ?? []);
      const handover = checkText(dependency.handover ?? '', 'handover');
      return database.write(() => {
        findRecord(workId);
        const dependencyId = randomUUID();
        const now = new Date().toISOString();
        insertRow.run(dependencyId, workId, need, owner, contract, evidence, ticket, JSON.stringify(pullRequests), handover, now, now);
        bump(workId);
        return fromRow(find(dependencyId));
      });
    },
    dependency: (dependencyId) => database.read(() => fromRow(find(dependencyId))),
    dependencies: (workId) => database.read(() => {
      findRecord(workId);
      return (ownedRows.all(workId) as unknown as Row[]).map(fromRow);
    }),
    blockingDependencies: (buildId) => database.read(() => {
      findRecord(buildId);
      return (blockingRows.all(buildId) as unknown as Row[]).map(fromRow);
    }),
    unmetDependencies: (buildId) => database.read(() => {
      findRecord(buildId);
      return (unmetRows.all(buildId) as unknown as Row[]).map(fromRow);
    }),
    updateDependency: (dependencyId, revision, update) => {
      const patch: Partial<Row> = {};
      if (update?.need !== undefined) patch.need = checkFilled(update.need, 'need');
      if (update.owner !== undefined) patch.owner = checkFilled(update.owner, 'owner');
      if (update.contract !== undefined) patch.contract = checkText(update.contract, 'contract');
      if (update.evidence !== undefined) patch.evidence = checkText(update.evidence, 'evidence');
      if (update.handover !== undefined) patch.handover = checkText(update.handover, 'handover');
      if (update.ticket !== undefined) patch.ticket = update.ticket === null ? null : checkReference(update.ticket, 'ticket');
      if (update.pullRequests !== undefined) patch.pull_requests = JSON.stringify(checkPullRequests(update.pullRequests));
      return change(dependencyId, revision, (row) => keepNamed(row, patch));
    },
    addDependencyBlock: (dependencyId, revision, buildId) => change(dependencyId, revision, (row) => {
      findBuild(buildId);
      if (root(buildId) !== root(row.work_id)) throw invalid(`The build ${buildId} isn't in the same work tree as ${row.work_id}, which holds the Dependency ${dependencyId}.`);
      if (blockRows.all(dependencyId).some((block) => block.build_id === buildId)) throw invalid(`The Dependency ${dependencyId} already blocks ${buildId}.`);
      insertBlock.run(dependencyId, buildId);
      bump(buildId);
      return {};
    }),
    removeDependencyBlock: (dependencyId, revision, buildId) => change(dependencyId, revision, () => {
      if (!deleteBlock.run(dependencyId, buildId).changes) throw invalid(`The Dependency ${dependencyId} doesn't block ${buildId}.`);
      bump(buildId);
      return {};
    }),
    observeDependency: (dependencyId, revision, observation) => {
      const subject = checkReference(observation?.subject, 'observed ticket or PR');
      if (!DEPENDENCY_OBSERVATION_KINDS.includes(observation.kind)) {
        throw invalid(`The observation "${String(observation.kind)}" isn't one of ${DEPENDENCY_OBSERVATION_KINDS.join(', ')}.`);
      }
      const detail = observation.detail === undefined ? null : checkFilled(observation.detail, 'observation detail');
      return change(dependencyId, revision, (row) => {
        if (subject !== row.ticket && !(JSON.parse(row.pull_requests) as string[]).includes(subject)) {
          throw invalid(`${subject} isn't the Dependency's ticket or one of its PRs.`);
        }
        const now = new Date().toISOString();
        const last = observationRow.get(dependencyId, subject);
        const answered = last && !FAILED_READS.includes(last.kind as DependencyObservationKind);
        const lastGood = !FAILED_READS.includes(observation.kind) ? null
          : answered ? { kind: last.kind, at: last.observed_at } : { kind: last?.last_good_kind ?? null, at: last?.last_good_at ?? null };
        writeObservation.run(dependencyId, subject, observation.kind, detail, now, lastGood?.kind ?? null, lastGood?.at ?? null);
        const settled = last?.kind === 'read-failed' ? last.last_good_kind : last?.kind;
        const changed = observation.kind !== 'read-failed' && settled != null && settled !== observation.kind;
        return row.met_at && changed && !row.needs_review_at ? { needs_review_at: now } : {};
      });
    },
    markDependencyMet: (dependencyId, revision, by) => {
      const who = checkFilled(by, 'met mark identity');
      return change(dependencyId, revision, () => ({ met_by: who, met_at: new Date().toISOString(), needs_review_at: null }));
    },
    clearDependencyMet: (dependencyId, revision) => change(dependencyId, revision, (row) => {
      if (!row.met_at) throw invalid(`The Dependency ${dependencyId} isn't marked met.`);
      return { met_by: null, met_at: null, needs_review_at: null };
    }),
    replaceDependencyWithBuild: (dependencyId, revision, buildId) => change(dependencyId, revision, () => {
      findBuild(buildId);
      for (const dependent of blockRows.all(dependencyId).map((block) => String(block.build_id))) {
        if (dependent === buildId) throw invalid(`The build ${buildId} is held by the Dependency ${dependencyId}, so it can't block itself.`);
        if (waitsOn.get(buildId, dependent)) throw invalid(`The build ${buildId} already waits on ${dependent}, so blocking ${dependent} by it would make a cycle.`);
        if (!hasBlocker.get(dependent, buildId)) insertBlocker.run(dependent, buildId);
        bump(dependent);
      }
      deleteBlocks.run(dependencyId);
      bump(buildId);
      return { replaced_by: buildId };
    }),
    treeConflict: (workId, parentId) => {
      const moved = { workId, parentId };
      for (const block of allBlocks.all()) {
        if (root(String(block.build_id), moved) !== root(String(block.work_id), moved)) {
          return `The Dependency ${String(block.dependency_id)} blocks the build ${String(block.build_id)}, which would leave the same work tree as ${String(block.work_id)}.`;
        }
      }
      return null;
    },
    kindConflict: (buildId) => {
      const block = blockingRow.get(buildId);
      return block ? `The build ${buildId} is blocked by the Dependency ${String(block.dependency_id)}, so it stays a build.` : null;
    },
    recordDependencyTicket: (dependencyId, ticket) => {
      const row = find(dependencyId);
      if (row.ticket === ticket) return;
      save(row, keepNamed(row, { ticket: checkReference(ticket, 'ticket') }));
      bump(row.work_id);
    },
    retentionReason: (workId, due) => {
      const owned = ownedRows.all(workId) as unknown as Row[];
      const unmetOwned = owned.find((row) => !row.met_at);
      if (unmetOwned) return `It holds the unmet Dependency ${unmetOwned.dependency_id}.`;
      for (const row of owned) {
        const kept = blockRows.all(row.dependency_id).map((block) => String(block.build_id)).find((buildId) => !due(buildId));
        if (kept) return `It holds the Dependency ${row.dependency_id}, which blocks the kept build ${kept}.`;
      }
      const unmetBlock = unmetRows.get(workId) as Row | undefined;
      return unmetBlock ? `The unmet Dependency ${unmetBlock.dependency_id} blocks it.` : null;
    },
  };
}
