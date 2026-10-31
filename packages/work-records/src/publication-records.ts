import { createHash, randomUUID } from 'node:crypto';
import type {
  GateEvidence, GateResult, PublicationAttachment, PublicationAttempt, PublicationContent, PublicationLocation, PublicationOperation,
  PublicationOutcome, PublicationPending, PublicationPlan, PublicationProposal, PublicationReadiness, PublicationSource, PublishedText,
} from '@lar-factory/shared';
import { WorkRecordError, type Database } from './database.ts';
import type { WorkRecord } from './work-records.ts';

export interface PublicationRecords {
  gate(workId: string): GateResult;
  recordGate(workId: string, revision: number, evidence: Pick<GateEvidence, 'briefDigest' | 'approvedBy' | 'evidence'>): GateEvidence;
  publicationReadiness(workId: string): PublicationReadiness;
  /** Batched board projection. Does not load source text, fingerprints or plan payloads. */
  publicationSummaries(): Map<string, Pick<PublicationReadiness, 'eligible' | 'reasons'> & { recoverable?: true }>;
  publicationReceipt(workId: string): { ticket: string; url: string } | null;
  recordCreationVerification(workId: string, planId: string, revision: number, operationId: string, verified: boolean, evidence: string): PublicationPlan;
  proposePublication(workId: string, revision: number, proposal: PublicationProposal): PublicationPlan;
  publication(workId: string, planId: string): PublicationPlan;
  publications(workId: string): PublicationPlan[];
  approvePublication(workId: string, planId: string, revision: number, digest: string, approvedBy: string): PublicationPlan;
  /** A current content argument must come from current settings and provider reads, not a cached plan. */
  pendingPublication(workId: string, planId: string, current?: PublicationContent): PublicationPending;
  claimPublication(workId: string, planId: string, revision: number, digest: string, current: PublicationContent, claimedBy: string): { plan: PublicationPlan; operation: PublicationOperation; claimToken: string };
  recordPublicationOutcome(workId: string, planId: string, revision: number, operationId: string, claimToken: string, outcome: PublicationOutcome): PublicationPlan;
  resolvePublicationOutcome(workId: string, planId: string, revision: number, operationId: string, resolvedBy: string, outcome: PublicationOutcome): PublicationPlan;
  recordPublicationEvidence(workId: string, planId: string, revision: number, operationId: string, evidence: string): PublicationPlan;
  publicationEvidence(workId: string, planId: string): { operationId: string; evidence: string; recordedAt: string }[];
  lastPublished(workId: string): PublishedText[];
  publicationHandover(workId: string, planId: string): string;
  publicationAttachment(workId: string): PublicationAttachment | null;
  attachPublicationUrl(workId: string, revision: number, planId: string, ticket: string, url: string): WorkRecord;
  /** The successful write that handed a Dependency's request to its owning team, or null before it. */
  dependencyHandoff(dependencyId: string): { operationId: string; ticket: string; url: string } | null;
}

const invalid = (message: string): never => { throw new WorkRecordError('invalid', message); };
const filled = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || !value.trim()) return invalid(`The ${name} is empty or isn't text.`);
  return value;
};
const object = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid('Expected an object.');
  return value as Record<string, unknown>;
};
const keys = (value: unknown, allowed: string[]) => {
  for (const key of Object.keys(object(value))) if (!allowed.includes(key)) invalid(`Unexpected publication field ${key}.`);
};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : invalid('Expected a publication list.');
const integer = (value: unknown, name: string, minimum = 1): number =>
  Number.isSafeInteger(value) && Number(value) >= minimum ? Number(value) : invalid(`The ${name} must be a whole number from ${minimum}.`);
const oneOf = <T extends string>(value: unknown, choices: readonly T[]): T =>
  choices.includes(value as T) ? value as T : invalid(`Expected one of ${choices.join(', ')}.`);
const unique = (values: string[], name: string) => { if (new Set(values).size !== values.length) invalid(`Duplicate ${name}.`); };
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const now = () => new Date().toISOString();
const reference = (value: unknown): string => {
  const text = filled(value, 'ticket reference');
  if (!/^[^\s/#]+(\/[^\s/#]+)+#[1-9]\d*$/.test(text)) invalid('Expected a ticket reference like owner/name#12.');
  return text;
};
const url = (value: unknown): string => {
  const text = filled(value, 'ticket URL');
  let parsed: URL;
  try { parsed = new URL(text); } catch { return invalid('Expected an HTTP or HTTPS ticket URL.'); }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) invalid('Expected an HTTP or HTTPS ticket URL without credentials.');
  return text;
};
function location(value: unknown): PublicationLocation {
  const item = object(value);
  if (item.kind === 'body') {
    keys(item, ['kind', 'start', 'end', 'field']);
    const field = item.field === undefined ? undefined : oneOf(item.field, ['System.Description', 'Microsoft.VSTS.TCM.ReproSteps']);
    const start = integer(item.start, 'body start', 0);
    const end = integer(item.end, 'body end', 0);
    if (end < start) invalid('The body boundary ends before it starts.');
    return { kind: 'body', start, end, ...(field ? { field } : {}) };
  }
  keys(item, ['kind', 'commentId']);
  oneOf(item.kind, ['comment']);
  return { kind: 'comment', commentId: filled(item.commentId, 'comment ID') };
}

/** Owns the journal alongside the existing writer, using the same SQLite transactions. */
export function publicationRecords(database: Database, readRecord: (workId: string) => WorkRecord,
  recordDependencyTicket: (dependencyId: string, ticket: string) => void): PublicationRecords {
  const { db } = database;
  const find = (workId: string) => readRecord(workId);
  const expected = (workId: string, revision: number) => {
    const record = find(workId);
    integer(revision, 'revision');
    if (record.revision !== revision) throw new WorkRecordError('stale-revision', `The work record ${workId} is at revision ${record.revision}, not ${revision}; read it again and retry.`);
    return record;
  };
  const body = (workId: string, name: string) => db.prepare('SELECT markdown FROM bodies WHERE work_id = ? AND body = ?').get(workId, name)?.markdown as string | undefined;
  const gate = (workId: string): GateResult => {
    find(workId);
    const brief = body(workId, 'brief');
    const briefDigest = brief?.trim() ? digest(brief) : null;
    const evidence = db.prepare('SELECT * FROM brief_gates WHERE work_id = ? ORDER BY rowid').all(workId).map((row): GateEvidence => ({
      gateId: String(row.gate_id), workId, sourceRevision: Number(row.source_revision), briefDigest: String(row.brief_digest),
      approvedBy: String(row.approved_by), evidence: String(row.evidence), recordedAt: String(row.recorded_at),
    }));
    return { briefDigest, current: briefDigest !== null && evidence.some((item) => item.briefDigest === briefDigest), evidence };
  };
  const children = (workId: string): WorkRecord[] => db.prepare('SELECT work_id FROM work_records WHERE parent_id = ? AND set_aside_at IS NULL AND kind <> \'slice\' ORDER BY rowid').all(workId).map((row) => find(String(row.work_id)));
  const source = (workId: string): PublicationSource => {
    const record = find(workId);
    const bodies = db.prepare('SELECT body, markdown FROM bodies WHERE work_id = ? ORDER BY body').all(workId);
    const blockers = db.prepare('SELECT blocker_id FROM blockers WHERE work_id = ? ORDER BY blocker_id').all(workId);
    const { evidence, briefDigest } = gate(workId);
    return {
      workId, revision: record.revision,
      digest: digest({ title: record.title, repository: record.repository, kind: record.kind, parentId: record.parentId,
        setAside: record.setAside, fogGone: record.fogGone, bodies, blockers, children: children(workId).map((child) => child.workId) }),
      gate: evidence.findLast((item) => item.briefDigest === briefDigest) ?? null,
    };
  };
  type Refinement = Pick<WorkRecord, 'workId' | 'kind' | 'setAside' | 'fogGone'>;
  type BodyReadiness = { written: number; hasContent: boolean; hasPassingGate: boolean };
  const eligibility = (root: Refinement, records: Refinement[], metadata: (workId: string, body: string) => BodyReadiness | undefined) => {
    const reasons: string[] = [];
    if (root.kind === 'decision' || root.kind === 'slice') reasons.push('Decisions and slices cannot publish.');
    if (root.setAside) reasons.push('The work is set aside.');
    if (root.kind === 'concept') {
      if (!root.fogGone) reasons.push('The concept still has Fog.');
      const map = metadata(root.workId, 'map');
      if (!map?.written || !map.hasContent) reasons.push('The concept has no map.');
      for (const decision of records.filter((item) => item.kind === 'decision')) {
        const answer = metadata(decision.workId, 'answer'); const drafts = metadata(decision.workId, 'domain-drafts');
        if (!answer || !drafts || !answer.hasContent || (map?.written ?? 0) <= Math.max(answer.written, drafts.written)) {
          reasons.push(`Decision ${decision.workId} is not settled in the map.`);
        }
      }
    }
    for (const item of records.filter((record) => !['concept', 'decision', 'slice'].includes(record.kind))) {
      if (!metadata(item.workId, 'brief')?.hasPassingGate) reasons.push(`The brief for ${item.workId} has no current passing gate.`);
    }
    return { eligible: !reasons.length, reasons };
  };
  const bodyReadiness = (row: Record<string, unknown>): BodyReadiness => ({ written: Number(row.written), hasContent: Boolean(row.has_content), hasPassingGate: Boolean(row.has_passing_gate) });
  const readiness = (workId: string): PublicationReadiness => {
    const root = find(workId);
    const records = root.kind === 'concept' ? [root, ...children(workId)] : [root];
    return { ...eligibility(root, records, (id, name) => {
      const row = db.prepare('SELECT written, has_content, has_passing_gate FROM bodies WHERE work_id = ? AND body = ?').get(id, name);
      return row ? bodyReadiness(row) : undefined;
    }), sources: records.map((item) => source(item.workId)) };
  };
  const load = (workId: string, planId: string): PublicationPlan => {
    find(workId);
    const row = db.prepare('SELECT * FROM publication_plans WHERE plan_id = ? AND work_id = ?').get(planId, workId);
    if (!row) throw new WorkRecordError('not-found', `No publication ${planId} belongs to ${workId}.`);
    const content = JSON.parse(String(row.content)) as PublicationContent;
    const attempts = new Map(db.prepare('SELECT operation_id, attempt FROM publication_outcomes WHERE plan_id = ?').all(planId)
      .map((item) => [String(item.operation_id), JSON.parse(String(item.attempt)) as PublicationAttempt]));
    return { ...content, planId, workId, revision: Number(row.revision), digest: String(row.digest), sources: JSON.parse(String(row.sources)) as PublicationSource[],
      replaces: row.replaces as string | null, supersededBy: row.superseded_by as string | null, proposedAt: String(row.proposed_at),
      approval: row.approval === null ? null : JSON.parse(String(row.approval)) as PublicationPlan['approval'],
      results: content.operations.map((operation) => ({ operation, status: attempts.get(operation.operationId)?.status ?? 'pending', attempt: attempts.get(operation.operationId) ?? null })),
    };
  };
  const planRevision = (workId: string, planId: string, revision: number) => {
    const plan = load(workId, planId);
    integer(revision, 'plan revision');
    if (plan.revision !== revision) throw new WorkRecordError('stale-revision', `The publication ${planId} is at revision ${plan.revision}, not ${revision}; inspect it and retry.`);
    return plan;
  };
  const bump = (planId: string) => db.prepare('UPDATE publication_plans SET revision = revision + 1 WHERE plan_id = ?').run(planId);
  const evidence = (planId: string, operationId: string, text: string) => db.prepare('INSERT INTO publication_evidence (plan_id, operation_id, evidence, recorded_at) VALUES (?, ?, ?, ?)').run(planId, operationId, text, now());
  const knownTicket = (workId: string): { ticket: string; url: string } | null => {
    const row = db.prepare('SELECT ticket, url FROM published_text WHERE work_id = ? ORDER BY rowid DESC LIMIT 1').get(workId)
      ?? db.prepare('SELECT ticket, url FROM publication_attachments WHERE work_id = ?').get(workId)
      ?? db.prepare(`WITH candidate_plans AS MATERIALIZED (
          SELECT p.plan_id, p.content FROM publication_sources s
          JOIN publication_plans p ON p.plan_id = s.plan_id WHERE s.work_id = ?
        )
        SELECT json_extract(o.attempt, '$.ticket') AS ticket, json_extract(o.attempt, '$.url') AS url
        FROM candidate_plans p CROSS JOIN json_each(p.content, '$.operations') op
        JOIN publication_outcomes o ON o.plan_id = p.plan_id AND o.operation_id = json_extract(op.value, '$.operationId')
        WHERE json_extract(op.value, '$.operationId') = o.operation_id AND json_extract(op.value, '$.kind') = 'create'
        AND json_extract(op.value, '$.ticketWorkId') = ? AND json_extract(o.attempt, '$.status') = 'successful'
        ORDER BY o.rowid DESC LIMIT 1`).get(workId, workId);
    return row ? { ticket: String(row.ticket), url: String(row.url) } : null;
  };
  const dependencyRow = (dependencyId: string) => db.prepare('SELECT work_id, owner, ticket FROM dependencies WHERE dependency_id = ?').get(dependencyId) as
    { work_id: string; owner: string; ticket: string | null } | undefined;
  const handoff = (dependencyId: string): { operationId: string; ticket: string; url: string } | null => {
    const holder = dependencyRow(dependencyId)?.work_id;
    const row = holder === undefined ? undefined : db.prepare(`SELECT o.operation_id, json_extract(o.attempt, '$.ticket') AS ticket, json_extract(o.attempt, '$.url') AS url
      FROM publication_sources s JOIN publication_plans p ON p.plan_id = s.plan_id CROSS JOIN json_each(p.content, '$.operations') op
      JOIN publication_outcomes o ON o.plan_id = p.plan_id AND o.operation_id = json_extract(op.value, '$.operationId')
      WHERE s.work_id = ? AND json_extract(op.value, '$.ticketWorkId') = ? AND json_extract(op.value, '$.kind') IN ('create', 'comment')
      AND json_extract(o.attempt, '$.status') = 'successful' ORDER BY o.rowid LIMIT 1`).get(holder, dependencyId);
    return row ? { operationId: String(row.operation_id), ticket: String(row.ticket), url: String(row.url) } : null;
  };
  /** The repository a Dependency's request goes to: its ticket's repository once it has one, else its owner. */
  const requestRepository = (dependency: { owner: string; ticket: string | null }, given: string | null | undefined) =>
    given ? given.slice(0, given.lastIndexOf('#')) : dependency.owner;
  const pending = (workId: string, planId: string, current?: PublicationContent): PublicationPending => {
    const plan = load(workId, planId);
    const ready = readiness(workId);
    const reasons = [...ready.reasons];
    if (plan.supersededBy) reasons.push('This publication was superseded.');
    if (!plan.approval) reasons.push('The exact publication content needs approval.');
    if (ready.sources.length !== plan.sources.length || plan.sources.some((saved) => ready.sources.find((item) => item.workId === saved.workId)?.digest !== saved.digest)) {
      reasons.push('The publication source changed; prepare and approve a new plan.');
    }
    if (current !== undefined && digest(current) !== digest({ tickets: plan.tickets, operations: plan.operations })) {
      reasons.push('The destination, mapping, content or required operations changed; prepare and approve a new plan.');
    }
    for (const ticket of plan.tickets) {
      const attached = ticket.dependencyOf ? dependencyRow(ticket.workId)?.ticket ?? null : find(ticket.workId).ticket;
      const planned = receipt(plan, ticket.workId);
      const known = ticket.dependencyOf ? handoff(ticket.workId) : knownTicket(ticket.workId);
      const uncompletedCreation = plan.results.some((item) => item.operation.kind === 'create' && item.operation.ticketWorkId === ticket.workId && item.status !== 'successful');
      if ((attached && attached !== (planned ?? known)?.ticket) || ((attached || known) && uncompletedCreation)) {
        reasons.push('The attached or known ticket changed the publication destination; prepare and approve a new plan.');
      }
    }
    for (const operation of plan.operations) {
      if (operation.kind === 'pr-closing-reference' && find(operation.ticketWorkId).pullRequest !== operation.pullRequest) {
        reasons.push('The delivery PR changed a required operation; prepare and approve a new plan.');
      }
    }
    for (const result of plan.results) {
      const verification = result.attempt?.verification;
      if (verification && verification.status !== 'verified') reasons.push(`Creation verification ${verification.status}: ${verification.evidence} Inspect the known ticket and prepare an approved correction; never recreate it.`);
    }
    const outstanding = plan.results.find((result) => result.status !== 'successful');
    return { plan, current: !reasons.length, reasons,
      next: !reasons.length && outstanding?.status === 'pending' ? outstanding.operation : null,
      successful: plan.results.filter((result) => result.status === 'successful').map((result) => result.operation.operationId),
      failed: plan.results.filter((result) => result.status === 'failed').map((result) => result.operation.operationId),
      uncertain: plan.results.filter((result) => result.status === 'uncertain').map((result) => result.operation.operationId),
    };
  };
  const validateContent = (content: PublicationContent, ready: PublicationReadiness, replaces?: string) => {
    keys(content, ['tickets', 'operations']);
    const ticketIds: string[] = [];
    const dependencyIds: string[] = [];
    const privateIds = db.prepare('SELECT work_id AS id FROM work_records UNION ALL SELECT dependency_id FROM dependencies').all().map((row) => String(row.id));
    const publicText = (value: unknown, name: string) => {
      const text = filled(value, name);
      if (privateIds.some((id) => text.includes(id)) || /<!--\s*(?:lar|factory)|\b(?:work-id|workId)\s*[:=]/i.test(text)) invalid('Published content must omit private work IDs and factory markers.');
      return text;
    };
    for (const item of list(content.tickets)) {
      const ticket = object(item);
      keys(ticket, ['workId', 'dependencyOf', 'settingsSnapshot', 'destination', 'vocabulary', 'typeResolution', 'title', 'body']);
      if (ticket.dependencyOf !== undefined) filled(ticket.dependencyOf, 'Dependency holder');
      if (ticket.settingsSnapshot !== undefined) filled(ticket.settingsSnapshot, 'settings snapshot');
      const workId = filled(ticket.workId, 'ticket work ID');
      ticketIds.push(workId);
      const destination = object(ticket.destination);
      keys(destination, ['provider', 'repository', 'project', 'ticket', 'url']);
      oneOf(destination.provider, ['github', 'azure']);
      if (destination.project !== undefined) filled(destination.project, 'destination project');
      if ((destination.ticket === undefined) !== (destination.url === undefined)) invalid('An existing destination needs both its ticket reference and URL.');
      if (ticket.dependencyOf !== undefined) {
        dependencyIds.push(workId);
        const dependency = dependencyRow(workId) ?? invalid('A Dependency request names no Dependency.');
        if (dependency.work_id !== ticket.dependencyOf || !ready.sources.some((item) => item.workId === dependency.work_id)) invalid('A Dependency request must come from work in this publication.');
        const done = handoff(workId);
        const given = dependency.ticket ?? done?.ticket;
        if (destination.repository !== requestRepository(dependency, given)) invalid('A Dependency request must go to its owning team\'s repository.');
        if (destination.ticket !== undefined && (reference(destination.ticket) !== given || !url(destination.url))) invalid('The destination differs from the Dependency\'s ticket.');
        if (given && destination.ticket === undefined && !content.operations.some((op) => op.operationId === done?.operationId && op.kind === 'create')) invalid('Use the Dependency\'s ticket instead of creating another one.');
      } else {
        const record = find(workId);
        if (!ready.sources.some((item) => item.workId === workId) || ['decision', 'slice'].includes(record.kind)) invalid('Only this publication\'s concept and builds can have tickets.');
        if (destination.repository !== record.repository) invalid('A ticket must go to its work\'s own repository.');
        if (destination.ticket !== undefined) {
          reference(destination.ticket); url(destination.url);
          if (record.ticket && record.ticket !== destination.ticket) invalid('The destination differs from the attached ticket.');
        } else if (record.ticket && knownTicket(workId)?.ticket !== record.ticket) invalid('A picked ticket needs an existing destination.');
        const known = knownTicket(workId);
        if (known && destination.ticket !== undefined && (destination.ticket !== known.ticket || destination.url !== known.url)) invalid('The destination differs from the known publication ticket.');
        if (known && destination.ticket === undefined) {
          const previous = replaces === undefined ? null : load(ready.sources[0]!.workId, replaces);
          const creation = previous?.results.find((result) => result.status === 'successful' && result.operation.kind === 'create' && result.operation.ticketWorkId === workId);
          if (!creation || !content.operations.some((op) => op.operationId === creation.operation.operationId && digest(op) === digest(creation.operation))) invalid('Use the known completed ticket instead of creating another one.');
        }
      }
      const types: string[] = [];
      for (const [name, term] of Object.entries(object(ticket.vocabulary))) {
        filled(name, 'Vocabulary term');
        keys(term, ['type', 'labels']);
        const mapping = object(term);
        if (mapping.type !== null) types.push(publicText(mapping.type, 'mapped type'));
        const labels = list(mapping.labels).map((label) => publicText(label, 'mapped label'));
        unique(labels, 'mapped label');
      }
      const resolution = object(ticket.typeResolution);
      keys(resolution, ['candidates', 'selected']);
      const candidates = list(resolution.candidates).map((type) => filled(type, 'candidate type'));
      unique(candidates, 'candidate type');
      if (digest([...new Set(types)].sort()) !== digest([...candidates].sort())) invalid('Type resolution must list every effective Vocabulary type candidate.');
      if (resolution.selected !== null && !candidates.includes(filled(resolution.selected, 'selected type'))) invalid('The selected type is not a Vocabulary candidate.');
      const title = publicText(ticket.title, 'published title');
      if (/[\r\n]/.test(title)) invalid('A published title must have one line.');
      publicText(ticket.body, 'published body');
    }
    unique(ticketIds, 'publication ticket');
    const requiredTickets = ready.sources.filter((item) => find(item.workId).kind !== 'decision').map((item) => item.workId);
    if (digest(ticketIds.filter((id) => !dependencyIds.includes(id)).sort()) !== digest(requiredTickets.sort())) invalid('The plan must include every active build and its concept.');
    const seen = new Set<string>();
    const created = new Set<string>();
    let relationships = false;
    for (const item of list(content.operations)) {
      const op = object(item);
      const kind = oneOf(op.kind, ['create', 'append', 'replace', 'comment', 'replace-comment', 'relationship', 'textual-relationship', 'pr-closing-reference']);
      const extras = { create: [], append: ['content', 'location', 'expectedText', 'expected'], replace: ['content', 'location', 'expectedText', 'expected'], comment: ['content', 'purpose'], 'replace-comment': ['content', 'location', 'expectedText'],
        relationship: ['relatedWorkId', 'relationship'], 'textual-relationship': ['relatedWorkId', 'relationship', 'content'], 'pr-closing-reference': ['pullRequest', 'content'] };
      keys(op, ['operationId', 'kind', 'ticketWorkId', 'dependsOn', ...extras[kind]]);
      const id = filled(op.operationId, 'operation ID');
      if (seen.has(id)) invalid('Duplicate operation ID.');
      const dependencies = list(op.dependsOn).map((value) => filled(value, 'operation dependency'));
      unique(dependencies, 'operation dependency');
      if (dependencies.some((dependency) => !seen.has(dependency))) invalid('Operations may depend only on earlier operations.');
      seen.add(id);
      const ticket = content.tickets.find((ticket) => ticket.workId === op.ticketWorkId);
      if (!ticket) invalid('The operation names no proposed ticket.');
      const target = ticket!;
      if (target.dependencyOf !== undefined) {
        // The owning team's ticket gets the request once; afterwards only handover text changes.
        if (kind !== 'create' && kind !== 'comment') invalid('A Dependency request is only created or posted; its team\'s ticket is never edited.');
        const done = handoff(target.workId);
        if (done && done.operationId !== id) invalid('The team\'s ticket already has the request. Prepare revised handover text instead of changing it.');
      }
      if (kind === 'create') {
        if (relationships) invalid('Create tickets before relationships.');
        if (target.destination.ticket || created.has(target.workId)) invalid('A ticket can be created only once.');
        const parent = target.dependencyOf ? null : find(target.workId).parentId;
        if (parent && ticketIds.includes(parent) && !created.has(parent) && !content.tickets.find((item) => item.workId === parent)?.destination.ticket) invalid('Create the parent ticket before its builds.');
        created.add(target.workId);
      } else {
        if (!target.destination.ticket && !created.has(target.workId)) invalid('An operation needs an existing ticket or an earlier creation.');
      }
      if (op.purpose !== undefined) oneOf(op.purpose, ['notice']);
      if ('content' in op) publicText(op.content, 'operation content');
      if (kind === 'append' || kind === 'replace') {
        if (op.expected !== undefined) {
          keys(op.expected, ['body', 'format', 'revision', 'assigned', 'linkedPullRequest', 'field']);
          const snapshot = object(op.expected);
          if (typeof snapshot.body !== 'string' || typeof snapshot.assigned !== 'boolean' || typeof snapshot.linkedPullRequest !== 'boolean') invalid('Expected the exact raw body and notification facts.');
          if (snapshot.field !== undefined) oneOf(snapshot.field, ['System.Description', 'Microsoft.VSTS.TCM.ReproSteps']);
          oneOf(snapshot.format, ['markdown', 'html', 'unsupported']);
          if (snapshot.revision !== undefined) integer(snapshot.revision, 'provider revision');
        }
        const boundary = location(op.location);
        if (boundary.kind !== 'body' || typeof op.expectedText !== 'string') invalid('Body writes require a body boundary and exact expected text.');
        if (boundary.kind === 'body' && boundary.end - boundary.start !== String(op.expectedText).length) invalid('The expected text must match the boundary length.');
        if (kind === 'append' && (boundary.kind !== 'body' || boundary.start !== boundary.end || op.expectedText !== '')) invalid('Append requires an empty insertion boundary.');
      }
      if (kind === 'replace-comment') {
        if (location(op.location).kind !== 'comment' || typeof op.expectedText !== 'string') invalid('A comment replacement needs its comment location and exact expected text.');
      }
      if (kind === 'relationship' || kind === 'textual-relationship') {
        relationships = true;
        const related = filled(op.relatedWorkId, 'related work ID');
        if (!ticketIds.includes(related) || related === target.workId) invalid('A relationship must name another ticket in this publication.');
        if (!content.tickets.find((item) => item.workId === related)?.destination.ticket && !created.has(related)) invalid('Create both tickets before their relationship.');
        oneOf(op.relationship, ['child', 'blocked-by']);
        if (dependencyIds.includes(related) && (op.relationship !== 'blocked-by'
          || !db.prepare('SELECT 1 FROM dependency_blocks WHERE dependency_id = ? AND build_id = ?').get(related, target.workId))) invalid('Only a build a Dependency blocks can link to its ticket, as blocked by it.');
      }
      if (kind === 'pr-closing-reference' && reference(op.pullRequest) !== find(target.workId).pullRequest) invalid("A closing reference must name this work's recorded delivery PR.");
    }
  };
  const writeAttempt = (planId: string, operationId: string, attempt: PublicationAttempt) => {
    db.prepare('INSERT INTO publication_outcomes (plan_id, operation_id, attempt) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET attempt = excluded.attempt').run(planId, operationId, JSON.stringify(attempt));
  };
  const receipt = (plan: PublicationPlan, workId: string): { ticket: string; url: string } | null => {
    const destination = plan.tickets.find((item) => item.workId === workId)?.destination;
    if (destination?.ticket && destination.url) return { ticket: destination.ticket, url: destination.url };
    const made = plan.results.find((item) => item.operation.ticketWorkId === workId && item.operation.kind === 'create' && item.status === 'successful')?.attempt;
    return made?.ticket && made.url ? { ticket: made.ticket, url: made.url } : null;
  };
  const outcome = (plan: PublicationPlan, operationId: string, value: PublicationOutcome, actor: { claimToken: string } | { resolvedBy: string }): PublicationPlan => {
    keys(value, ['status', 'evidence', 'ticket', 'url', 'location']);
    const result = plan.results.find((item) => item.operation.operationId === operationId);
    if (!result?.attempt || result.status !== 'uncertain') invalid('Only a claimed uncertain operation can receive an outcome.');
    const attempt = result!.attempt!;
    if ('claimToken' in actor && attempt.claimToken !== filled(actor.claimToken, 'claim token')) invalid('The claim token does not own this operation.');
    if ('claimToken' in actor && attempt.recordedAt !== null) invalid('The outcome was already recorded; reconcile it explicitly.');
    const status = oneOf(value.status, ['successful', 'failed', 'uncertain']);
    const proof = filled(value.evidence, 'provider evidence');
    if ('resolvedBy' in actor && status === 'uncertain') invalid('Reconciliation must resolve uncertainty to success or failure.');
    const op = result!.operation;
    let target: { ticket: string; url: string } | null = null;
    let publishedLocation: PublicationLocation | null = null;
    let text: string | null = null;
    if (status !== 'successful') {
      if ('ticket' in value || 'url' in value || 'location' in value) invalid('Failed and uncertain outcomes cannot claim a published location.');
    } else {
      const success = value as Extract<PublicationOutcome, { status: 'successful' }>;
      if (op.kind === 'create') {
        target = { ticket: reference(success.ticket), url: url(success.url) };
        if (!target.ticket.startsWith(`${plan.tickets.find((item) => item.workId === op.ticketWorkId)!.destination.repository}#`)) invalid('The created ticket must belong to its planned repository.');
      } else {
        target = receipt(plan, op.ticketWorkId);
        if (!target) invalid('The operation has no known ticket result.');
        if ((success.ticket !== undefined && success.ticket !== target!.ticket) || (success.url !== undefined && success.url !== target!.url)) invalid('The outcome differs from the approved ticket.');
      }
      if (['create', 'append', 'replace', 'comment', 'replace-comment', 'textual-relationship'].includes(op.kind)) {
        if (op.kind !== 'create' || success.location !== undefined) publishedLocation = location(success.location);
        text = op.kind === 'create' ? plan.tickets.find((item) => item.workId === op.ticketWorkId)!.body : 'content' in op ? op.content : null;
        if (publishedLocation && (op.kind === 'comment' || op.kind === 'replace-comment') && publishedLocation.kind !== 'comment') invalid('A comment outcome needs its comment location.');
        if (op.kind === 'replace-comment' && publishedLocation?.kind === 'comment' && publishedLocation.commentId !== op.location.commentId) invalid('The outcome differs from the approved comment location.');
        if (publishedLocation && ['create', 'append', 'replace'].includes(op.kind)) {
          if (publishedLocation.kind !== 'body' || publishedLocation.end - publishedLocation.start !== text!.length) invalid('A body outcome needs the exact published text boundary.');
          if (publishedLocation.kind === 'body' && op.kind === 'create' && publishedLocation.start !== 0) invalid('A created body starts at zero.');
          if (publishedLocation.kind === 'body' && (op.kind === 'append' || op.kind === 'replace') && (publishedLocation.start !== op.location.start || publishedLocation.field !== op.location.field)) invalid('The body outcome starts outside the approved boundary.');
        }
      } else if (success.location !== undefined) invalid('This operation has no published text location.');
    }
    if (op.kind === 'create' && status === 'successful' && !publishedLocation) text = null;
    const recordedAt = now();
    const next: PublicationAttempt = { ...attempt, status, evidence: proof, ticket: target?.ticket ?? null, url: target?.url ?? null,
      location: publishedLocation, ...(op.kind === 'create' && status === 'successful' && !publishedLocation ? { verification: { status: 'pending' as const, evidence: 'The ticket was created; stored content and terms still need inspection.' } } : {}), resolvedBy: 'resolvedBy' in actor ? filled(actor.resolvedBy, 'resolution identity') : null, recordedAt };
    writeAttempt(plan.planId, operationId, next);
    evidence(plan.planId, operationId, `${next.resolvedBy ? `Resolved by ${next.resolvedBy}: ` : ''}${status}: ${proof}`);
    const dependency = plan.tickets.find((item) => item.workId === op.ticketWorkId)?.dependencyOf !== undefined;
    // A Dependency records the ticket that received its request. Its text is never edited, so it keeps no published text.
    if (dependency && status === 'successful' && target) {
      recordDependencyTicket(op.ticketWorkId, target.ticket);
    }
    if (text !== null && target && publishedLocation && !dependency && !(op.kind === 'comment' && op.purpose === 'notice')) {
      db.prepare('INSERT INTO published_text (plan_id, operation_id, work_id, ticket, url, text, location, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(plan.planId, operationId, op.ticketWorkId, target.ticket, target.url, text, JSON.stringify(publishedLocation), recordedAt);
    }
    bump(plan.planId);
    return load(plan.workId, plan.planId);
  };
  return {
    gate: (workId) => database.read(() => gate(workId)),
    recordGate: (workId, revision, value) => database.write(() => {
      const record = expected(workId, revision);
      keys(value, ['briefDigest', 'approvedBy', 'evidence']);
      if (['concept', 'decision', 'slice'].includes(record.kind)) invalid('Only a publishable brief can pass a gate.');
      const current = gate(workId);
      if (!current.briefDigest || current.briefDigest !== value.briefDigest) invalid('The brief changed or is missing; inspect it before recording its gate.');
      const item: GateEvidence = { gateId: randomUUID(), workId, sourceRevision: revision, briefDigest: current.briefDigest!,
        approvedBy: filled(value.approvedBy, 'gate approval identity'), evidence: filled(value.evidence, 'gate evidence'), recordedAt: now() };
      db.prepare('INSERT INTO brief_gates (gate_id, work_id, source_revision, brief_digest, approved_by, evidence, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(item.gateId, workId, revision, item.briefDigest, item.approvedBy, item.evidence, item.recordedAt);
      db.prepare("UPDATE bodies SET has_passing_gate = 1 WHERE work_id = ? AND body = 'brief'").run(workId);
      return item;
    }),
    publicationReceipt: (workId) => database.read(() => { find(workId); return knownTicket(workId); }),
    recordCreationVerification: (workId, planId, revision, operationId, verified, proof) => database.write(() => {
      const plan = planRevision(workId, planId, revision);
      const result = plan.results.find((item) => item.operation.operationId === operationId);
      if (result?.operation.kind !== 'create' || result.status !== 'successful' || !result.attempt?.verification || result.attempt.verification.status === 'verified') invalid('Verification needs a created ticket with outstanding verification.');
      const attempt = result!.attempt!;
      const verification = { status: verified ? 'verified' as const : 'discrepancy' as const, evidence: filled(proof, 'verification evidence') };
      const ticket = plan.tickets.find((item) => item.workId === result!.operation.ticketWorkId)!;
      const boundary = verified ? { kind: 'body' as const, start: 0, end: ticket.body.length, ...(ticket.destination.provider === 'azure' ? { field: 'System.Description' as const } : {}) } : null;
      writeAttempt(planId, operationId, { ...attempt, verification, location: boundary });
      evidence(planId, operationId, `Creation verification ${verification.status}: ${verification.evidence}`);
      if (boundary && !ticket.dependencyOf) db.prepare('INSERT INTO published_text (plan_id, operation_id, work_id, ticket, url, text, location, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(planId, operationId, ticket.workId, attempt.ticket, attempt.url, ticket.body, JSON.stringify(boundary), now());
      bump(planId);
      return load(workId, planId);
    }),
    publicationSummaries: () => database.read(() => {
      const rows = db.prepare('SELECT work_id, kind, parent_id, set_aside_at, fog_gone_at FROM work_records ORDER BY rowid').all();
      const bodies = new Map(db.prepare('SELECT work_id, body, written, has_content, has_passing_gate FROM bodies').all()
        .map((row) => [`${row.work_id}:${row.body}`, bodyReadiness(row)]));
      const published = new Set(db.prepare('SELECT DISTINCT work_id FROM publication_plans').all().map((row) => String(row.work_id)));
      const refinements = rows.map((row) => ({ workId: String(row.work_id), kind: row.kind as WorkRecord['kind'], setAside: row.set_aside_at !== null, fogGone: row.fog_gone_at !== null }));
      const children = new Map<string, Refinement[]>();
      rows.forEach((row, index) => {
        if (row.parent_id && row.set_aside_at === null && row.kind !== 'slice') {
          const id = String(row.parent_id);
          if (!children.has(id)) children.set(id, []);
          children.get(id)!.push(refinements[index]!);
        }
      });
      return new Map(refinements.map((root) => [root.workId, { ...eligibility(root, root.kind === 'concept' ? [root, ...children.get(root.workId) ?? []] : [root],
        (id, name) => bodies.get(`${id}:${name}`)), ...(published.has(root.workId) ? { recoverable: true as const } : {}) }]));
    }),
    publicationReadiness: (workId) => database.read(() => readiness(workId)),
    proposePublication: (workId, revision, proposal) => database.write(() => {
      expected(workId, revision);
      keys(proposal, ['sources', 'tickets', 'operations', 'replaces']);
      const ready = readiness(workId);
      if (!ready.eligible) invalid(ready.reasons.join(' '));
      const sourceIds: string[] = [];
      for (const item of list(proposal.sources)) {
        keys(item, ['workId', 'revision']);
        const candidate = object(item);
        const id = filled(candidate.workId, 'source work ID');
        expected(id, integer(candidate.revision, 'source revision'));
        sourceIds.push(id);
      }
      unique(sourceIds, 'source record');
      if (digest([...sourceIds].sort()) !== digest(ready.sources.map((item) => item.workId).sort())) invalid('The plan must name every current source revision.');
      const content: PublicationContent = { tickets: proposal.tickets, operations: proposal.operations };
      validateContent(content, ready, proposal.replaces);
      const latest = db.prepare('SELECT plan_id FROM publication_plans WHERE work_id = ? AND superseded_by IS NULL ORDER BY rowid DESC LIMIT 1').get(workId);
      let previous: PublicationPlan | null = null;
      if (latest) {
        if (proposal.replaces !== latest.plan_id) invalid('A replacement must name the current publication plan.');
        previous = load(workId, String(latest.plan_id));
        if (previous.results.some((item) => item.status === 'uncertain')) invalid('Resolve uncertain outcomes before replacing the plan.');
      } else if (proposal.replaces !== undefined) invalid('There is no publication to replace.');
      const carried: { operationId: string; attempt: PublicationAttempt }[] = [];
      if (previous) {
        for (const result of previous.results.filter((item) => item.status === 'successful')) {
          const operation = content.operations.find((item) => item.operationId === result.operation.operationId);
          if (operation && digest(operation) !== digest(result.operation)) invalid('A completed operation cannot change in a replacement. Use a new operation ID.');
          if (operation) {
            const oldTicket = previous.tickets.find((item) => item.workId === operation.ticketWorkId)!;
            const newTicket = content.tickets.find((item) => item.workId === operation.ticketWorkId)!;
            // Settings evidence may refresh for outstanding writes. The completed provider payload stays exact.
            if (operation.kind === 'create' && digest({ ...oldTicket, settingsSnapshot: undefined }) !== digest({ ...newTicket, settingsSnapshot: undefined })) invalid('A completed creation cannot change. Use an existing ticket and a new update operation.');
            carried.push({ operationId: operation.operationId, attempt: result.attempt! });
          }
          if (result.operation.kind === 'create' && content.operations.some((item) => item.kind === 'create' && item.ticketWorkId === result.operation.ticketWorkId && item.operationId !== result.operation.operationId)) invalid('A completed ticket creation cannot be retried.');
        }
      }
      const planId = randomUUID();
      const replaces = previous?.planId ?? null;
      const hash = digest({ workId, ...content, sources: ready.sources, replaces });
      db.prepare('INSERT INTO publication_plans (plan_id, work_id, revision, digest, content, sources, replaces, proposed_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?)')
        .run(planId, workId, hash, JSON.stringify(content), JSON.stringify(ready.sources), replaces, now());
      for (const item of ready.sources) db.prepare('INSERT INTO publication_sources (plan_id, work_id) VALUES (?, ?)').run(planId, item.workId);
      if (previous) db.prepare('UPDATE publication_plans SET superseded_by = ?, revision = revision + 1 WHERE plan_id = ?').run(planId, previous.planId);
      for (const item of carried) writeAttempt(planId, item.operationId, item.attempt);
      return load(workId, planId);
    }),
    publication: (workId, planId) => database.read(() => load(workId, planId)),
    publications: (workId) => database.read(() => {
      find(workId);
      return db.prepare('SELECT plan_id FROM publication_plans WHERE work_id = ? ORDER BY rowid').all(workId).map((item) => load(workId, String(item.plan_id)));
    }),
    approvePublication: (workId, planId, revision, hash, approvedBy) => database.write(() => {
      const plan = planRevision(workId, planId, revision);
      if (plan.supersededBy || plan.approval) invalid('Only a current unapproved plan can receive approval.');
      if (hash !== plan.digest) invalid('Approval must name the digest of the exact proposed content.');
      const check = pending(workId, planId);
      const reasons = check.reasons.filter((reason) => reason !== 'The exact publication content needs approval.');
      if (reasons.length) invalid(reasons.join(' '));
      const approval = { approvedBy: filled(approvedBy, 'approval identity'), approvedAt: now(), digest: hash };
      db.prepare('UPDATE publication_plans SET approval = ?, revision = revision + 1 WHERE plan_id = ?').run(JSON.stringify(approval), planId);
      return load(workId, planId);
    }),
    pendingPublication: (workId, planId, current) => database.read(() => pending(workId, planId, current)),
    claimPublication: (workId, planId, revision, hash, current, claimedBy) => database.write(() => {
      const plan = planRevision(workId, planId, revision);
      if (hash !== plan.digest) invalid('Claim must name the approved plan digest.');
      if (current === undefined) invalid('Claim needs the current destination, mapping, content and operations.');
      const check = pending(workId, planId, current);
      if (!check.current) invalid(check.reasons.join(' '));
      if (!check.next) invalid('No operation can be dispatched. Reconcile uncertainty or approve a replacement for failed work.');
      const operation = check.next!;
      if (operation.kind === 'create') {
        const otherClaims = db.prepare(`SELECT p.work_id, p.plan_id, o.operation_id FROM publication_outcomes o
          JOIN publication_plans p ON p.plan_id = o.plan_id WHERE json_extract(o.attempt, '$.status') = 'uncertain'`).all();
        for (const other of otherClaims) {
          const claimed = load(String(other.work_id), String(other.plan_id)).operations.find((op) => op.operationId === other.operation_id);
          if (claimed?.kind === 'create' && claimed.ticketWorkId === operation.ticketWorkId) invalid('Another publication has an uncertain creation for this work; reconcile it first.');
        }
      }
      const claimToken = randomUUID();
      writeAttempt(planId, operation.operationId, { claimToken, claimedBy: filled(claimedBy, 'claim identity'), claimedAt: now(),
        status: 'uncertain', evidence: null, ticket: null, url: null, location: null, resolvedBy: null, recordedAt: null });
      evidence(planId, operation.operationId, 'Claimed before provider dispatch; outcome is uncertain until recorded.');
      bump(planId);
      return { plan: load(workId, planId), operation, claimToken };
    }),
    recordPublicationOutcome: (workId, planId, revision, operationId, claimToken, value) => database.write(() => outcome(planRevision(workId, planId, revision), operationId, value, { claimToken })),
    resolvePublicationOutcome: (workId, planId, revision, operationId, resolvedBy, value) => database.write(() => outcome(planRevision(workId, planId, revision), operationId, value, { resolvedBy })),
    recordPublicationEvidence: (workId, planId, revision, operationId, proof) => database.write(() => {
      const plan = planRevision(workId, planId, revision);
      if (!plan.results.some((item) => item.operation.operationId === operationId && item.attempt)) invalid('Evidence needs a claimed operation.');
      evidence(planId, operationId, filled(proof, 'provider evidence'));
      bump(planId);
      return load(workId, planId);
    }),
    publicationEvidence: (workId, planId) => database.read(() => {
      load(workId, planId);
      return db.prepare('SELECT operation_id, evidence, recorded_at FROM publication_evidence WHERE plan_id = ? ORDER BY rowid').all(planId)
        .map((item) => ({ operationId: String(item.operation_id), evidence: String(item.evidence), recordedAt: String(item.recorded_at) }));
    }),
    lastPublished: (workId) => database.read(() => {
      find(workId);
      return db.prepare(`SELECT p.*, plans.content FROM published_text p JOIN publication_plans plans ON plans.plan_id = p.plan_id WHERE p.work_id = ? AND NOT EXISTS (
        SELECT 1 FROM published_text newer WHERE newer.work_id = p.work_id AND newer.ticket = p.ticket AND json_extract(newer.location, '$.kind') = json_extract(p.location, '$.kind')
        AND (json_extract(p.location, '$.kind') = 'body' OR json_extract(newer.location, '$.commentId') = json_extract(p.location, '$.commentId'))
        AND newer.rowid > p.rowid
      ) ORDER BY p.rowid`).all(workId).map((item): PublishedText => ({ planId: String(item.plan_id), operationId: String(item.operation_id), workId,
        operationKind: (JSON.parse(String(item.content)) as PublicationContent).operations.find((op) => op.operationId === item.operation_id)!.kind,
        ticket: String(item.ticket), url: String(item.url), text: String(item.text), location: JSON.parse(String(item.location)) as PublicationLocation, recordedAt: String(item.recorded_at) }));
    }),
    publicationHandover: (workId, planId) => database.read(() => {
      const plan = load(workId, planId);
      const sections = plan.tickets.map((ticket) => {
        if (ticket.dependencyOf) return [`# ${ticket.title}`, ticket.body].join('\n\n');
        const extra = plan.operations.filter((op) => op.ticketWorkId === ticket.workId && op.kind !== 'append' && op.kind !== 'replace' && 'content' in op && op.content !== ticket.body)
          .map((op) => 'content' in op ? op.content : '');
        const record = find(ticket.workId);
        const relations = [...record.parentId ? [{ workId: record.parentId, text: 'Part of' }] : [],
          ...db.prepare('SELECT blocker_id FROM blockers WHERE work_id = ? ORDER BY blocker_id').all(ticket.workId).map((blocker) => ({ workId: String(blocker.blocker_id), text: 'Depends on' })),
          ...db.prepare('SELECT dependency_id FROM dependency_blocks WHERE build_id = ? ORDER BY rowid').all(ticket.workId).map((block) => ({ workId: String(block.dependency_id), text: 'Depends on' }))];
        const links = relations.flatMap((relation) => {
          const related = plan.tickets.find((item) => item.workId === relation.workId);
          return related ? [`${relation.text} ${receipt(plan, related.workId)?.url ?? related.title}`] : [];
        });
        return [`# ${ticket.title}`, ticket.body, ...new Set([...extra, ...links])].join('\n\n');
      });
      return `${sections.join('\n\n---\n\n')}\n`;
    }),
    publicationAttachment: (workId) => database.read(() => {
      find(workId);
      const item = db.prepare('SELECT * FROM publication_attachments WHERE work_id = ?').get(workId);
      return item ? { workId, planId: String(item.plan_id), ticket: String(item.ticket), url: String(item.url), recordedAt: String(item.recorded_at) } : null;
    }),
    dependencyHandoff: (dependencyId) => database.read(() => handoff(dependencyId)),
    attachPublicationUrl: (workId, revision, planId, ticket, ticketUrl) => database.write(() => {
      const record = expected(workId, revision);
      const ref = reference(ticket);
      const link = url(ticketUrl);
      const owner = db.prepare('SELECT work_id FROM publication_plans WHERE plan_id = ?').get(planId);
      if (!owner) invalid('The publication plan does not exist.');
      const plan = load(String(owner!.work_id), planId);
      if (!plan.tickets.some((item) => item.workId === workId)) invalid('The publication does not contain this work.');
      if (!ref.startsWith(`${record.repository}#`)) invalid('The ticket must belong to the work\'s repository.');
      const known = receipt(plan, workId);
      if (known) {
        const expectedPage = new URL(known.url); const postedPage = new URL(link);
        if (known.ticket !== ref || expectedPage.origin !== postedPage.origin || expectedPage.pathname !== postedPage.pathname) invalid('The attached URL differs from the publication result.');
      }
      if (record.ticket && record.ticket !== ref) invalid('The work already has another ticket.');
      const holder = db.prepare('SELECT work_id FROM work_records WHERE ticket = ? AND work_id <> ?').get(ref, workId);
      if (holder) throw new WorkRecordError('ticket-taken', `The ticket ${ref} already belongs to ${String(holder.work_id)}.`);
      const attached = db.prepare('SELECT ticket, url FROM publication_attachments WHERE work_id = ?').get(workId);
      if (attached && (attached.ticket !== ref || attached.url !== link)) invalid('The work already has another publication URL.');
      db.prepare('INSERT INTO publication_attachments (work_id, ticket, url, plan_id, recorded_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING').run(workId, ref, link, planId, now());
      if (!record.ticket) db.prepare('UPDATE work_records SET ticket = ?, revision = revision + 1, updated_at = ? WHERE work_id = ?').run(ref, now(), workId);
      return find(workId);
    }),
  };
}
