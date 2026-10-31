// The work-record database's schema, one step per entry. Never edit a released step: add one.

import { createHash } from 'node:crypto';
import type { Migration } from './database.ts';

export const MIGRATIONS: readonly Migration[] = [
  (db) => db.exec(`
    CREATE TABLE work_records (
      work_id TEXT PRIMARY KEY,
      repository TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      -- A Queued record's place in its repository's Queue; null in every other Status.
      queue_order INTEGER,
      ticket TEXT UNIQUE,
      set_aside_at TEXT,
      revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX work_records_by_repository ON work_records (repository, status);
  `),
  (db) => db.exec(`
    -- A record's one structural parent: a concept owns decisions and builds, a build owns slices.
    ALTER TABLE work_records ADD COLUMN parent_id TEXT REFERENCES work_records (work_id);
    CREATE INDEX work_records_by_parent ON work_records (parent_id);
    -- work_id waits on blocker_id. The module keeps the edges acyclic.
    CREATE TABLE blockers (
      work_id TEXT NOT NULL REFERENCES work_records (work_id),
      blocker_id TEXT NOT NULL REFERENCES work_records (work_id),
      PRIMARY KEY (work_id, blocker_id),
      CHECK (work_id <> blocker_id)
    ) STRICT;
    CREATE INDEX blockers_by_blocker ON blockers (blocker_id);
  `),
  (db) => db.exec(`
    -- Where a build stands in the lar-build workflow, and the PR it delivers through.
    ALTER TABLE work_records ADD COLUMN build_phase TEXT;
    ALTER TABLE work_records ADD COLUMN pull_request TEXT;
    -- Private markdown: a brief, a decision's text or a concept's map. Nothing here is written to a provider.
    CREATE TABLE bodies (
      work_id TEXT NOT NULL REFERENCES work_records (work_id),
      body TEXT NOT NULL,
      markdown TEXT NOT NULL,
      PRIMARY KEY (work_id, body)
    ) STRICT;
    -- A build's review rounds: each reviewer axis's verdict, then its findings in the order it gave them.
    CREATE TABLE review_rounds (
      work_id TEXT NOT NULL REFERENCES work_records (work_id),
      round INTEGER NOT NULL,
      base TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      PRIMARY KEY (work_id, round)
    ) STRICT;
    CREATE TABLE review_axes (
      work_id TEXT NOT NULL,
      round INTEGER NOT NULL,
      axis TEXT NOT NULL,
      verdict TEXT NOT NULL,
      not_checked TEXT,
      PRIMARY KEY (work_id, round, axis),
      FOREIGN KEY (work_id, round) REFERENCES review_rounds (work_id, round)
    ) STRICT;
    CREATE TABLE review_findings (
      work_id TEXT NOT NULL,
      round INTEGER NOT NULL,
      axis TEXT NOT NULL,
      finding INTEGER NOT NULL,
      severity TEXT NOT NULL,
      summary TEXT NOT NULL,
      disposition TEXT NOT NULL,
      reason TEXT,
      PRIMARY KEY (work_id, round, axis, finding),
      FOREIGN KEY (work_id, round, axis) REFERENCES review_axes (work_id, round, axis)
    ) STRICT;
    -- The T3 threads that worked on a record. A thread works on one record.
    CREATE TABLE threads (
      thread_id TEXT PRIMARY KEY,
      work_id TEXT NOT NULL REFERENCES work_records (work_id),
      purpose TEXT NOT NULL,
      recorded_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX threads_by_work_id ON threads (work_id);
    -- A start the board asked T3 for, kept until it resolves to T3's thread ID or a failure.
    CREATE TABLE launch_intents (
      intent_id TEXT PRIMARY KEY,
      work_id TEXT NOT NULL REFERENCES work_records (work_id),
      purpose TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      thread_id TEXT,
      failure TEXT,
      resolved_at TEXT
    ) STRICT;
    CREATE INDEX launch_intents_by_work_id ON launch_intents (work_id);
  `),
  (db) => db.exec(`
    -- When the work was finished, recorded from its delivery PR. Retention counts from it; Status never sets it.
    ALTER TABLE work_records ADD COLUMN finished_at TEXT;
  `),
  (db) => db.exec(`
    -- The title and context a record was captured or imported with. A later ticket edit never changes them.
    ALTER TABLE work_records ADD COLUMN title TEXT NOT NULL DEFAULT '';
    ALTER TABLE work_records ADD COLUMN initial_context TEXT NOT NULL DEFAULT '';
    -- Why the record waits on the user, set and cleared by the board; null when it doesn't.
    ALTER TABLE work_records ADD COLUMN needs_you TEXT;
    -- The project skills selected when the build started, as a JSON list; null before it starts.
    ALTER TABLE work_records ADD COLUMN skills TEXT;
    -- When a concept's Fog was recorded gone; null while some remains.
    ALTER TABLE work_records ADD COLUMN fog_gone_at TEXT;
    -- Orders body writes across records, so completion can tell a concept's map was written after a decision's answer.
    ALTER TABLE bodies ADD COLUMN written INTEGER NOT NULL DEFAULT 0;
    -- The delivery PRs a record held before its current one, kept as history.
    CREATE TABLE replaced_pull_requests (
      work_id TEXT NOT NULL REFERENCES work_records (work_id),
      pull_request TEXT NOT NULL,
      replaced_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX replaced_pull_requests_by_work_id ON replaced_pull_requests (work_id);
    -- The last read of a record's ticket or current PR from its provider, one row of each. A newer read replaces it;
    -- a failed read keeps it and records when and why the read failed. state is null until a read succeeds.
    CREATE TABLE observations (
      work_id TEXT NOT NULL REFERENCES work_records (work_id),
      observed TEXT NOT NULL,
      subject TEXT NOT NULL,
      state TEXT,
      assignee TEXT,
      observed_at TEXT,
      failed_at TEXT,
      failure TEXT,
      PRIMARY KEY (work_id, observed)
    ) STRICT;
  `),
  (db) => db.exec(`
    CREATE TABLE brief_gates (
      gate_id TEXT PRIMARY KEY,
      work_id TEXT NOT NULL REFERENCES work_records (work_id) ON DELETE CASCADE,
      source_revision INTEGER NOT NULL,
      brief_digest TEXT NOT NULL,
      approved_by TEXT NOT NULL,
      evidence TEXT NOT NULL,
      recorded_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX brief_gates_by_work ON brief_gates (work_id);
    CREATE TABLE publication_plans (
      plan_id TEXT PRIMARY KEY,
      work_id TEXT NOT NULL REFERENCES work_records (work_id) ON DELETE CASCADE,
      revision INTEGER NOT NULL,
      digest TEXT NOT NULL,
      content TEXT NOT NULL,
      sources TEXT NOT NULL,
      replaces TEXT UNIQUE REFERENCES publication_plans (plan_id),
      superseded_by TEXT REFERENCES publication_plans (plan_id),
      proposed_at TEXT NOT NULL,
      approval TEXT
    ) STRICT;
    CREATE INDEX publication_plans_by_work ON publication_plans (work_id);
    -- References protect source records and relationship endpoints until their journal can be safely removed.
    CREATE TABLE publication_sources (
      plan_id TEXT NOT NULL REFERENCES publication_plans (plan_id) ON DELETE CASCADE,
      work_id TEXT NOT NULL REFERENCES work_records (work_id),
      PRIMARY KEY (plan_id, work_id)
    ) STRICT;
    CREATE INDEX publication_sources_by_work ON publication_sources (work_id);
    CREATE TABLE publication_outcomes (
      plan_id TEXT NOT NULL REFERENCES publication_plans (plan_id) ON DELETE CASCADE,
      operation_id TEXT NOT NULL,
      attempt TEXT NOT NULL,
      PRIMARY KEY (plan_id, operation_id)
    ) STRICT;
    -- Reconciliation and provider evidence are append-only, including uncertainty that was later resolved.
    CREATE TABLE publication_evidence (
      plan_id TEXT NOT NULL REFERENCES publication_plans (plan_id) ON DELETE CASCADE,
      operation_id TEXT NOT NULL,
      evidence TEXT NOT NULL,
      recorded_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE published_text (
      plan_id TEXT NOT NULL REFERENCES publication_plans (plan_id) ON DELETE CASCADE,
      operation_id TEXT NOT NULL,
      work_id TEXT NOT NULL REFERENCES work_records (work_id),
      ticket TEXT NOT NULL,
      url TEXT NOT NULL,
      text TEXT NOT NULL,
      location TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      PRIMARY KEY (plan_id, operation_id)
    ) STRICT;
    CREATE TABLE publication_attachments (
      work_id TEXT PRIMARY KEY REFERENCES work_records (work_id) ON DELETE CASCADE,
      ticket TEXT NOT NULL UNIQUE,
      url TEXT NOT NULL,
      plan_id TEXT NOT NULL REFERENCES publication_plans (plan_id),
      recorded_at TEXT NOT NULL
    ) STRICT;
  `),
  (db) => {
    db.exec('ALTER TABLE bodies ADD COLUMN has_content INTEGER NOT NULL DEFAULT 0; ALTER TABLE bodies ADD COLUMN has_passing_gate INTEGER NOT NULL DEFAULT 0');
    const update = db.prepare(`UPDATE bodies SET has_content = ?, has_passing_gate = EXISTS (
      SELECT 1 FROM brief_gates WHERE work_id = ? AND brief_digest = ?
    ) WHERE work_id = ? AND body = ?`);
    for (const row of db.prepare('SELECT work_id, body, markdown FROM bodies').all()) {
      const markdown = String(row.markdown);
      const digest = row.body === 'brief' && markdown.trim() ? createHash('sha256').update(JSON.stringify(markdown)).digest('hex') : '';
      update.run(Number(Boolean(markdown.trim())), String(row.work_id), digest, String(row.work_id), String(row.body));
    }
  },
  (db) => db.exec(`
    -- A change a work record needs from a team that owns another repository. It lives inside its record. Only the user
    -- sets met_at; needs_review_at records that an observation changed after it was set.
    CREATE TABLE dependencies (
      dependency_id TEXT PRIMARY KEY,
      work_id TEXT NOT NULL REFERENCES work_records (work_id),
      need TEXT NOT NULL,
      owner TEXT NOT NULL,
      contract TEXT NOT NULL,
      evidence TEXT NOT NULL,
      ticket TEXT,
      -- A JSON list of PR references.
      pull_requests TEXT NOT NULL,
      handover TEXT NOT NULL,
      met_by TEXT,
      met_at TEXT,
      needs_review_at TEXT,
      -- The build its dependents wait on instead, kept as history after the build itself may be deleted.
      replaced_by TEXT,
      revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX dependencies_by_work_id ON dependencies (work_id);
    -- The builds a Dependency holds; it holds no others.
    CREATE TABLE dependency_blocks (
      dependency_id TEXT NOT NULL REFERENCES dependencies (dependency_id),
      build_id TEXT NOT NULL REFERENCES work_records (work_id),
      PRIMARY KEY (dependency_id, build_id)
    ) STRICT;
    CREATE INDEX dependency_blocks_by_build ON dependency_blocks (build_id);
    -- The latest read of a Dependency's ticket or one of its PRs. A newer read replaces it, whatever its kind.
    CREATE TABLE dependency_observations (
      dependency_id TEXT NOT NULL REFERENCES dependencies (dependency_id),
      subject TEXT NOT NULL,
      kind TEXT NOT NULL,
      detail TEXT,
      observed_at TEXT NOT NULL,
      -- The last read that answered, kept beside a read that failed or lost access; null after a read that answered.
      last_good_kind TEXT,
      last_good_at TEXT,
      PRIMARY KEY (dependency_id, subject)
    ) STRICT;
  `),
];
