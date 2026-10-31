import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { effectiveVocabulary, type PublicationTicket } from '@lar-factory/shared';
import type { PublicationSettings } from '@lar-factory/shared/publication-settings';
import { openWorkRecords, type WorkRecords } from './work-records.ts';
import { publicationEngine, type PublicationDocument } from './publication-engine.ts';
import { publicationProvider, PublicationRefused, type PublicationProvider } from './publication-providers.ts';

const opened: WorkRecords[] = [];
const dirs: string[] = [];
afterEach(() => { opened.splice(0).forEach((r) => r.close()); dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })); });
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'publication-engine-')); dirs.push(dir);
  const path = join(dir, 'records.db');
  const records = await openWorkRecords(path); opened.push(records);
  return { records, path };
}
function document(workId: string): PublicationDocument {
  return { workId, title: 'Find saved searches', outcome: 'Find a saved search by name.', change: 'Add a name filter.', checks: ['A saved search appears for its name.'],
    assumptions: ['Names are case insensitive.'], decisions: [{ decision: 'Use a prefix match.', reason: 'Keep results predictable.' }],
    builderNotes: ['Use the existing query.'], domainNotes: ['Name means the saved display name.'], relatedTickets: ['https://github.com/team/app/issues/4'] };
}
async function passing(records: WorkRecords, repo = 'team/app') {
  let record = records.create({ title: 'Search', repository: repo, kind: 'build' });
  record = records.setBody(record.workId, record.revision, 'brief', 'Private brief.');
  records.recordGate(record.workId, record.revision, { briefDigest: records.gate(record.workId).briefDigest!, approvedBy: 'reviewer', evidence: 'Passed.' });
  return record;
}
function settings(repo: string): PublicationSettings {
  const vocab = effectiveVocabulary({ build: { type: 'Task', labels: ['Search'] } });
  return { snapshot: `settings:${repo}`, discovery: { provider: 'github', types: { state: 'available', choices: ['Task'] }, labels: { state: 'available', choices: ['Search'] } },
    setup: { repo, role: '', itemSource: { kind: 'issues' }, labels: [], domainDocs: { kind: 'private' }, skills: [], ...vocab, access: {} as PublicationSettings['setup']['access'],
      consent: ['publish-ticket', 'edit-ticket', 'tag-ticket', 'type-ticket', 'comment-ticket', 'relate-ticket'], paused: [], sources: {} as PublicationSettings['setup']['sources'], shared: {} } };
}
function provider() {
  const writes: { ticket: PublicationTicket; kind: string }[] = [];
  const client: PublicationProvider = {
    readBody: async () => ({ body: '', format: 'markdown', assigned: false, linkedPullRequest: false }),
    writeBody: async () => {}, replaceComment: async () => {},
    capability: async () => ({ available: true }),
    create: async (ticket) => { writes.push({ ticket, kind: 'create' }); return { ticket: `${ticket.destination.repository}#${writes.length}`, url: `https://github.com/${ticket.destination.repository}/issues/${writes.length}` }; },
    relate: async (ticket) => { writes.push({ ticket, kind: 'relationship' }); },
    comment: async (ticket) => { writes.push({ ticket, kind: 'comment' }); return 'comment-1'; },
    search: async () => [], inspect: async (ticket, target) => ({ ...target, title: ticket.title, body: ticket.body, type: ticket.typeResolution.selected, labels: [...new Set(Object.values(ticket.vocabulary).flatMap((term) => term.labels))] }), findComments: async () => [], hasRelationship: async () => false,
  };
  return { client, writes };
}

it('previews complete team content without writing and executes an approved standalone plan', async () => {
  const { records } = await fixture(); const work = await passing(records); const { client, writes } = provider();
  const engine = publicationEngine(records, { settings: async (repo) => settings(repo), provider: client });
  const plan = await engine.prepare(work.workId, { documents: [document(work.workId)] });
  expect(writes).toEqual([]);
  expect(plan.tickets[0]).toMatchObject({ destination: { repository: 'team/app' }, vocabulary: { build: { type: 'Task', labels: ['Search'] } }, body:
    '## Outcome\n\nFind a saved search by name.\n\n## Change\n\nAdd a name filter.\n\n## Completion checks\n\n- A saved search appears for its name.\n\n## Confirmed assumptions\n\n- Names are case insensitive.\n\n## Decisions and reasons\n\n- Use a prefix match. Keep results predictable.\n\n## Implementation notes\n\n- Use the existing query.\n\n## Domain notes\n\n- Name means the saved display name.\n\n## Related tickets\n\n- https://github.com/team/app/issues/4' });
  expect(await engine.execute(work.workId, plan.planId, 'cli')).toMatchObject({ current: false, successful: [] });
  records.approvePublication(work.workId, plan.planId, plan.revision, plan.digest, 'person');
  expect(await engine.execute(work.workId, plan.planId, 'cli')).toMatchObject({ successful: [`create:${work.workId}`], failed: [], uncertain: [] });
  expect(writes).toHaveLength(1);
  expect(records.lastPublished(work.workId)[0]?.text).toBe(plan.tickets[0]?.body);
  expect(records.read(work.workId)).toMatchObject({ status: 'List', ticket: null });
});

it('creates a concept and several builds in their own repositories before child and blocked-by links', async () => {
  const { records } = await fixture(); let concept = records.create({ title: 'Search', repository: 'team/app', kind: 'concept' });
  const builds = [await passing(records), await passing(records, 'team/api'), await passing(records)];
  for (const build of builds) records.setParent(build.workId, records.read(build.workId).revision, concept.workId);
  records.addBlocker(builds[2]!.workId, records.read(builds[2]!.workId).revision, builds[1]!.workId);
  concept = records.setBody(concept.workId, records.read(concept.workId).revision, 'map', 'Private destination.');
  records.setFogGone(concept.workId, concept.revision, true);
  // Decisions and slices are retained privately and never become tickets.
  const decision = records.create({ title: 'Matching', repository: 'team/app', kind: 'decision' });
  records.setParent(decision.workId, decision.revision, concept.workId);
  records.setBody(decision.workId, records.read(decision.workId).revision, 'answer', 'Prefix matching.');
  records.setBody(decision.workId, records.read(decision.workId).revision, 'domain-drafts', '');
  records.setBody(concept.workId, records.read(concept.workId).revision, 'map', 'Private destination incorporating the decision.');
  const slice = records.create({ title: 'Private slice', repository: 'team/app', kind: 'slice' });
  records.setParent(slice.workId, slice.revision, builds[0]!.workId);
  const { client, writes } = provider();
  const engine = publicationEngine(records, { settings: async (repo) => settings(repo), provider: client });
  const plan = await engine.prepare(concept.workId, { documents: [concept, ...builds].map((r) => document(r.workId)) });
  expect(plan.tickets.map((t) => t.workId)).toEqual([concept, ...builds].map((r) => r.workId));
  records.approvePublication(concept.workId, plan.planId, plan.revision, plan.digest, 'person');
  const result = await engine.execute(concept.workId, plan.planId, 'cli');
  expect(result.successful).toHaveLength(8);
  expect(result.failed).toEqual([]);
  expect(writes.map((w) => w.kind)).toEqual(['create', 'create', 'create', 'create', 'relationship', 'relationship', 'relationship', 'relationship']);
  expect(writes[2]?.ticket.destination.repository).toBe('team/api');
  expect(records.publication(concept.workId, plan.planId).results.filter((r) => r.operation.kind === 'create').map((r) => r.attempt?.ticket)).toEqual(['team/app#1', 'team/app#2', 'team/api#3', 'team/app#4']);
});

it('rechecks sources between writes and retains the parent when the source changes', async () => {
  const { records } = await fixture(); let concept = records.create({ title: 'Search', repository: 'team/app', kind: 'concept' });
  const build = await passing(records); records.setParent(build.workId, build.revision, concept.workId);
  concept = records.setBody(concept.workId, records.read(concept.workId).revision, 'map', 'Private destination.');
  records.setFogGone(concept.workId, concept.revision, true);
  const { client, writes } = provider(); const create = client.create;
  client.create = async (ticket) => { const made = await create(ticket); records.setBody(build.workId, records.read(build.workId).revision, 'brief', 'Changed brief.'); return made; };
  const engine = publicationEngine(records, { settings: async (repo) => settings(repo), provider: client });
  const plan = await engine.prepare(concept.workId, { documents: [document(concept.workId), document(build.workId)] });
  records.approvePublication(concept.workId, plan.planId, plan.revision, plan.digest, 'person');
  expect(await engine.execute(concept.workId, plan.planId, 'cli')).toMatchObject({ current: false, successful: [`create:${concept.workId}`], reasons: expect.arrayContaining([expect.stringContaining('no current passing gate')]) });
  expect(writes).toHaveLength(1);
  expect(records.lastPublished(concept.workId)).toHaveLength(1);
});

it('retains successful siblings and requires replacement approval after an explicit creation refusal', async () => {
  const { records } = await fixture(); let concept = records.create({ title: 'Search', repository: 'team/app', kind: 'concept' });
  const builds = [await passing(records), await passing(records, 'team/api')];
  for (const build of builds) records.setParent(build.workId, records.read(build.workId).revision, concept.workId);
  concept = records.setBody(concept.workId, records.read(concept.workId).revision, 'map', 'Private destination.'); records.setFogGone(concept.workId, concept.revision, true);
  const { client, writes } = provider(); const create = client.create;
  client.create = async (ticket) => { if (ticket.destination.repository === 'team/api') throw new PublicationRefused('HTTP 403 creation refused.'); return create(ticket); };
  const engine = publicationEngine(records, { settings: async (repo) => settings(repo), provider: client });
  const request = { documents: [concept, ...builds].map((r) => document(r.workId)) };
  const plan = await engine.prepare(concept.workId, request); records.approvePublication(concept.workId, plan.planId, plan.revision, plan.digest, 'person');
  const result = await engine.execute(concept.workId, plan.planId, 'cli');
  expect(result).toMatchObject({ successful: [`create:${concept.workId}`, `create:${builds[0]!.workId}`], failed: [`create:${builds[1]!.workId}`], uncertain: [] });
  await engine.resume(concept.workId, plan.planId, 'cli'); expect(writes).toHaveLength(2);
  records.attachPublicationUrl(concept.workId, records.read(concept.workId).revision, plan.planId, 'team/app#1', 'https://github.com/team/app/issues/1');
  client.create = create;
  const replacement = await engine.prepare(concept.workId, { ...request, replaces: plan.planId });
  expect(await engine.execute(concept.workId, replacement.planId, 'cli')).toMatchObject({ current: false }); expect(writes).toHaveLength(2);
  records.approvePublication(concept.workId, replacement.planId, replacement.revision, replacement.digest, 'person');
  expect((await engine.execute(concept.workId, replacement.planId, 'cli')).failed).toEqual([]);
  expect(writes.filter((w) => w.kind === 'create')).toHaveLength(3);
});

it.each(['unavailable', 'refused'])('previews an exact textual fallback after a native relationship is %s', async (failure) => {
  const { records } = await fixture(); let concept = records.create({ title: 'Search', repository: 'team/app', kind: 'concept' });
  const build = await passing(records); records.setParent(build.workId, build.revision, concept.workId);
  concept = records.setBody(concept.workId, records.read(concept.workId).revision, 'map', 'Private destination.'); records.setFogGone(concept.workId, concept.revision, true);
  const { client, writes } = provider();
  if (failure === 'unavailable') client.capability = async () => ({ available: false, reason: 'Unsupported hierarchy.' });
  else client.relate = async () => { throw new PublicationRefused('HTTP 403 link refused.'); };
  const engine = publicationEngine(records, { settings: async (repo) => settings(repo), provider: client });
  const plan = await engine.prepare(concept.workId, { documents: [document(concept.workId), document(build.workId)] });
  records.approvePublication(concept.workId, plan.planId, plan.revision, plan.digest, 'person');
  expect((await engine.execute(concept.workId, plan.planId, 'cli')).failed).toHaveLength(1);
  expect(writes.map((w) => w.kind)).toEqual(['create', 'create']);
  const fallback = await engine.fallback(concept.workId, plan.planId);
  expect(fallback.operations.at(-1)).toMatchObject({ kind: 'textual-relationship', ticketWorkId: build.workId, content: 'Part of https://github.com/team/app/issues/1' });
  await engine.execute(concept.workId, fallback.planId, 'cli'); expect(writes).toHaveLength(2);
  records.approvePublication(concept.workId, fallback.planId, fallback.revision, fallback.digest, 'person');
  expect((await engine.execute(concept.workId, fallback.planId, 'cli')).failed).toEqual([]);
  expect(writes.map((w) => w.kind)).toEqual(['create', 'create', 'comment']);
  expect(records.lastPublished(build.workId).at(-1)).toMatchObject({ text: 'Part of https://github.com/team/app/issues/1', location: { kind: 'comment', commentId: 'comment-1' } });
});

it('restarts after a lost creation response, inspects candidates and requires selection without duplicating', async () => {
  const { records, path } = await fixture(); const work = await passing(records); const { client, writes } = provider(); const create = client.create;
  client.create = async (ticket) => { await create(ticket); throw new Error('Connection lost after creation.'); };
  let engine = publicationEngine(records, { settings: async (repo) => settings(repo), provider: client });
  const plan = await engine.prepare(work.workId, { documents: [document(work.workId)] }); records.approvePublication(work.workId, plan.planId, plan.revision, plan.digest, 'person');
  expect((await engine.execute(work.workId, plan.planId, 'cli')).uncertain).toHaveLength(1);
  const reopened = await openWorkRecords(path); opened.push(reopened); engine = publicationEngine(reopened, { settings: async (repo) => settings(repo), provider: client });
  expect((await engine.resume(work.workId, plan.planId, 'board')).uncertain).toHaveLength(1); expect(writes).toHaveLength(1);
  expect((await engine.reconcile(work.workId, plan.planId, 'person')).uncertain).toHaveLength(1);
  await expect(engine.prepare(work.workId, { documents: [document(work.workId)], replaces: plan.planId })).rejects.toThrow(/Resolve uncertain/);
  const target = { ticket: 'team/app#1', url: 'https://github.com/team/app/issues/1' };
  client.search = async () => [target];
  client.inspect = async () => ({ ...target, title: plan.tickets[0]!.title, body: plan.tickets[0]!.body, type: 'Task', labels: ['Search'] });
  const found = await engine.reconcile(work.workId, plan.planId, 'person'); expect(found.candidates[0]?.tickets).toEqual([target]); expect(found.uncertain).toHaveLength(1);
  expect(await engine.reconcile(work.workId, plan.planId, 'person', [{ operationId: `create:${work.workId}`, ticket: target.ticket }])).toMatchObject({ uncertain: [], successful: [`create:${work.workId}`] });
  await engine.resume(work.workId, plan.planId, 'board'); expect(writes).toHaveLength(1);
});

it('does not invent a feature mapping for structural build records', async () => {
  const { records } = await fixture(); const work = await passing(records); const { client } = provider();
  const config = settings('team/app'); config.setup.vocabulary.feature = { type: 'Feature', labels: ['Feature'] };
  config.discovery.types = { state: 'available', choices: ['Task', 'Feature'] }; config.discovery.labels = { state: 'available', choices: ['Search', 'Feature'] };
  const engine = publicationEngine(records, { settings: async () => config, provider: client });
  const plan = await engine.prepare(work.workId, { documents: [document(work.workId)] });
  expect(plan.tickets[0]?.vocabulary).toEqual({ build: { type: 'Task', labels: ['Search'] } });
});

it.each(['mapping', 'destination', 'consent'])('stops before a write when %s changes after approval', async (change) => {
  const { records } = await fixture(); const work = await passing(records); const { client, writes } = provider();
  const config = settings('team/app'); const engine = publicationEngine(records, { settings: async () => config, provider: client });
  const plan = await engine.prepare(work.workId, { documents: [document(work.workId)] }); records.approvePublication(work.workId, plan.planId, plan.revision, plan.digest, 'person');
  if (change === 'mapping') { config.setup.vocabulary.build.labels = []; config.snapshot = 'new mapping'; }
  if (change === 'destination') { config.setup.itemSource = { kind: 'azure-board', team: 'Another team' }; config.snapshot = 'new destination'; }
  if (change === 'consent') config.setup.consent = config.setup.consent.filter((op) => op !== 'type-ticket');
  const result = await engine.execute(work.workId, plan.planId, 'cli');
  expect(result.current).toBe(false); expect(result.reasons.length).toBeGreaterThan(0); expect(writes).toEqual([]);
  expect(records.publication(work.workId, plan.planId).results[0]?.status).toBe('pending');
});

it('allows only one dispatch when the command and board execute concurrently', async () => {
  const { records, path } = await fixture(); const work = await passing(records); const { client, writes } = provider();
  const create = client.create; let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  client.create = async (ticket) => { const made = await create(ticket); await wait; return made; };
  const engine = publicationEngine(records, { settings: async (repo) => settings(repo), provider: client });
  const otherRecords = await openWorkRecords(path); opened.push(otherRecords);
  const other = publicationEngine(otherRecords, { settings: async (repo) => settings(repo), provider: client });
  const plan = await engine.prepare(work.workId, { documents: [document(work.workId)] }); records.approvePublication(work.workId, plan.planId, plan.revision, plan.digest, 'person');
  const first = engine.execute(work.workId, plan.planId, 'cli');
  const second = other.execute(work.workId, plan.planId, 'board');
  // Both attempts reach the journal before the one provider response is released.
  await second; release();
  const completed = await first;
  expect(completed.successful).toHaveLength(1); expect(writes).toHaveLength(1);
});

it('rejects unfinished refinement, stale gate evidence, unresolved types and private workflow wording without writes', async () => {
  const { records } = await fixture(); const work = records.create({ title: 'Search', repository: 'team/app', kind: 'feature' }); const { client, writes } = provider();
  const config = settings('team/app'); const engine = publicationEngine(records, { settings: async () => config, provider: client });
  await expect(engine.prepare(work.workId, { documents: [document(work.workId)] })).rejects.toThrow(/no current passing gate/);
  records.setBody(work.workId, work.revision, 'brief', 'First brief.');
  records.recordGate(work.workId, records.read(work.workId).revision, { briefDigest: records.gate(work.workId).briefDigest!, approvedBy: 'reviewer', evidence: 'Passed.' });
  records.setBody(work.workId, records.read(work.workId).revision, 'brief', 'Changed brief.');
  await expect(engine.prepare(work.workId, { documents: [document(work.workId)] })).rejects.toThrow(/no current passing gate/);
  records.recordGate(work.workId, records.read(work.workId).revision, { briefDigest: records.gate(work.workId).briefDigest!, approvedBy: 'reviewer', evidence: 'Passed.' });
  config.setup.vocabulary.feature = { type: 'Feature', labels: [] }; config.discovery.types = { state: 'available', choices: ['Task', 'Feature'] };
  await expect(engine.prepare(work.workId, { documents: [document(work.workId)] })).rejects.toThrow(/Choose one team type or none/);
  await expect(engine.prepare(work.workId, { documents: [{ ...document(work.workId), builderNotes: ['Finish the factory slices.'] }], typeSelections: { [work.workId]: null } })).rejects.toThrow(/team language/);
  const plan = await engine.prepare(work.workId, { documents: [document(work.workId)], typeSelections: { [work.workId]: null } });
  expect(plan.tickets[0]?.typeResolution).toEqual({ candidates: ['Task', 'Feature'], selected: null });
  expect(writes).toEqual([]);
});

it('requires a new preview after settings change while retaining the exact completed creation', async () => {
  const { records } = await fixture(); let concept = records.create({ title: 'Search', repository: 'team/app', kind: 'concept' }); const build = await passing(records, 'team/api');
  records.setParent(build.workId, build.revision, concept.workId); concept = records.setBody(concept.workId, records.read(concept.workId).revision, 'map', 'Private destination.'); records.setFogGone(concept.workId, concept.revision, true);
  let snapshot = 'original'; const { client, writes } = provider(); const create = client.create;
  client.create = async (ticket) => { const made = await create(ticket); snapshot = 'changed'; return made; };
  const engine = publicationEngine(records, { provider: client, settings: async (repo) => ({ ...settings(repo), snapshot }) });
  const request = { documents: [document(concept.workId), document(build.workId)] };
  const plan = await engine.prepare(concept.workId, request); records.approvePublication(concept.workId, plan.planId, plan.revision, plan.digest, 'person');
  expect(await engine.execute(concept.workId, plan.planId, 'cli')).toMatchObject({ current: false, successful: [`create:${concept.workId}`] });
  const replacement = await engine.prepare(concept.workId, { ...request, replaces: plan.planId });
  expect(replacement.results[0]?.status).toBe('successful');
  expect(replacement.tickets[0]?.body).toBe(plan.tickets[0]?.body);
  expect(replacement.tickets[0]?.settingsSnapshot).toBe('changed');
  records.approvePublication(concept.workId, replacement.planId, replacement.revision, replacement.digest, 'person');
  expect((await engine.execute(concept.workId, replacement.planId, 'cli')).failed).toEqual([]); expect(writes.filter((w) => w.kind === 'create')).toHaveLength(2);
});

it('inspects uncertain native links and textual comments before resolving their outcomes', async () => {
  const { records } = await fixture(); let concept = records.create({ title: 'Search', repository: 'team/app', kind: 'concept' }); const build = await passing(records);
  records.setParent(build.workId, build.revision, concept.workId); concept = records.setBody(concept.workId, records.read(concept.workId).revision, 'map', 'Private destination.'); records.setFogGone(concept.workId, concept.revision, true);
  const { client } = provider(); let linked = false;
  client.relate = async () => { linked = true; throw new Error('Lost native link response.'); }; client.hasRelationship = async () => linked;
  const engine = publicationEngine(records, { provider: client, settings: async (repo) => settings(repo) });
  const plan = await engine.prepare(concept.workId, { documents: [document(concept.workId), document(build.workId)] }); records.approvePublication(concept.workId, plan.planId, plan.revision, plan.digest, 'person');
  expect((await engine.execute(concept.workId, plan.planId, 'cli')).uncertain).toHaveLength(1);
  expect((await engine.reconcile(concept.workId, plan.planId, 'person')).uncertain).toEqual([]);
  // A separately approved textual link has its own uncertainty and exact comment candidate.
  const operations = [...plan.operations, { kind: 'textual-relationship' as const, operationId: 'additional-reference', ticketWorkId: build.workId, relatedWorkId: concept.workId, relationship: 'child' as const,
    dependsOn: [plan.operations.at(-1)!.operationId], content: 'Part of https://github.com/team/app/issues/1' }];
  const next = records.proposePublication(concept.workId, records.read(concept.workId).revision, { tickets: plan.tickets, operations, sources: records.publicationReadiness(concept.workId).sources.map(({ workId, revision }) => ({ workId, revision })), replaces: plan.planId });
  records.approvePublication(concept.workId, next.planId, next.revision, next.digest, 'person');
  client.comment = async () => { throw new Error('Lost comment response.'); };
  client.findComments = async () => [{ commentId: '24', content: 'Part of https://github.com/team/app/issues/1' }];
  expect((await engine.execute(concept.workId, next.planId, 'cli')).uncertain).toEqual(['additional-reference']);
  const found = await engine.reconcile(concept.workId, next.planId, 'person');
  expect(found.candidates[0]).toMatchObject({ comments: ['24'] }); expect(found.uncertain).toEqual(['additional-reference']);
  expect((await engine.reconcile(concept.workId, next.planId, 'person', [{ operationId: 'additional-reference', commentId: '24' }])).uncertain).toEqual([]);
});

it('rejects incomplete team documents before recording a preview or dispatching', async () => {
  const { records } = await fixture(); const work = await passing(records); const { client, writes } = provider();
  const engine = publicationEngine(records, { provider: client, settings: async (repo) => settings(repo) });
  await expect(engine.prepare(work.workId, { documents: [{ workId: work.workId, title: 'Incomplete' } as PublicationDocument] })).rejects.toThrow(/complete team document/);
  expect(records.publications(work.workId)).toEqual([]); expect(writes).toEqual([]);
});

it('runs Azure concept publication through the real adapter and recovers a lost child response from inspected fields', async () => {
  const { records } = await fixture(); let concept = records.create({ title: 'Search', repository: 'contoso/project/app', kind: 'concept' });
  const builds = [await passing(records, 'contoso/project/app'), await passing(records, 'contoso/project/api')];
  for (const build of builds) records.setParent(build.workId, build.revision, concept.workId);
  concept = records.setBody(concept.workId, records.read(concept.workId).revision, 'map', 'Private destination.'); records.setFogGone(concept.workId, concept.revision, true);
  const items = new Map<number, { id: number; rev: number; fields: Record<string, string>; multilineFieldsFormat: Record<string, string> }>();
  const writes: unknown[] = []; let lost = false;
  const adapter = publicationProvider({ github: async () => { throw new Error('Unexpected GitHub call.'); }, azure: async (args) => {
    const file = args.includes('--in-file') ? args[args.indexOf('--in-file') + 1] : args.includes('--body') ? args[args.indexOf('--body') + 1]?.slice(1) : undefined;
    const body = file ? JSON.parse(readFileSync(file, 'utf8')) : undefined;
    if (args.includes('workitemrelationtypes')) return JSON.stringify({ value: [{ referenceName: 'System.LinkTypes.Hierarchy-Reverse', attributes: { enabled: true } }] });
    if (args.includes('workitemsbatch')) return JSON.stringify({ value: body.ids.map((id: number) => items.get(id)) });
    if (args.includes('wiql')) return JSON.stringify({ workItems: [...items.values()].map(({ id }) => ({ id })) });
    if (args.includes('workitems')) {
      writes.push(body); const id = items.size + 1; const fields = Object.fromEntries(body.filter((op: { path: string }) => op.path.startsWith('/fields/')).map((op: { path: string; value: string }) => [op.path.slice(8), op.value]));
      fields['System.WorkItemType'] = 'Task'; items.set(id, { id, rev: 1, fields, multilineFieldsFormat: { 'System.Description': 'Markdown' } });
      if (id === 3 && !lost) { lost = true; throw new Error('Lost response after Azure creation.'); }
      return JSON.stringify({ id });
    }
    if (args[0] === 'rest') { writes.push(body); return '{}'; }
    throw new Error(`Unexpected Azure fixture call: ${args.join(' ')}`);
  } });
  const engine = publicationEngine(records, { provider: adapter, settings: async (repo) => {
    const config = settings(repo); config.discovery.provider = 'azure'; config.setup.itemSource = { kind: 'azure-board', team: 'Team' }; config.setup.vocabulary.concept = { type: 'Task', labels: ['Search'] }; return config;
  } });
  const documents = [concept, ...builds].map((r, index) => ({ ...document(r.workId), title: `Search ${index}` }));
  const plan = await engine.prepare(concept.workId, { documents }); records.approvePublication(concept.workId, plan.planId, plan.revision, plan.digest, 'person');
  expect(await engine.execute(concept.workId, plan.planId, 'cli')).toMatchObject({ successful: [`create:${concept.workId}`, `create:${builds[0]!.workId}`], uncertain: [`create:${builds[1]!.workId}`] });
  expect(writes).toHaveLength(3);
  expect((await engine.reconcile(concept.workId, plan.planId, 'person')).candidates[0]?.tickets).toEqual([{ ticket: 'contoso/project/api#3', url: 'https://dev.azure.com/contoso/project/_workitems/edit/3' }]);
  await engine.reconcile(concept.workId, plan.planId, 'person', [{ operationId: `create:${builds[1]!.workId}`, ticket: 'contoso/project/api#3' }]);
  expect(await engine.resume(concept.workId, plan.planId, 'board')).toMatchObject({ failed: [], uncertain: [], successful: expect.any(Array) });
  expect(writes).toHaveLength(5);
  expect(JSON.stringify(writes)).not.toMatch(/workId|private|Assignee|AssignedTo|Priority|Iteration|System.State|repo-|status-/);
});

it('offers separately consented textual links when native relationship consent is withheld', async () => {
  const { records } = await fixture(); let concept = records.create({ title: 'Search', repository: 'team/app', kind: 'concept' }); const build = await passing(records);
  records.setParent(build.workId, build.revision, concept.workId); concept = records.setBody(concept.workId, records.read(concept.workId).revision, 'map', 'Private destination.'); records.setFogGone(concept.workId, concept.revision, true);
  const { client, writes } = provider(); const config = settings('team/app'); config.setup.consent = config.setup.consent.filter((op) => op !== 'relate-ticket');
  const engine = publicationEngine(records, { provider: client, settings: async () => config });
  const plan = await engine.prepare(concept.workId, { documents: [document(concept.workId), document(build.workId)] }); records.approvePublication(concept.workId, plan.planId, plan.revision, plan.digest, 'person');
  expect(await engine.execute(concept.workId, plan.planId, 'cli')).toMatchObject({ current: false, successful: [`create:${concept.workId}`, `create:${build.workId}`] });
  expect(writes).toHaveLength(2);
  const fallback = await engine.fallback(concept.workId, plan.planId);
  records.approvePublication(concept.workId, fallback.planId, fallback.revision, fallback.digest, 'person');
  expect((await engine.execute(concept.workId, fallback.planId, 'cli')).failed).toEqual([]);
  expect(writes.map((w) => w.kind)).toEqual(['create', 'create', 'comment']);
});

it('appends to a picked description and replaces only its recorded section after unrelated edits', async () => {
  const { records } = await fixture();
  let work = records.create({ title: 'Search', repository: 'team/app', kind: 'build', ticket: 'team/app#12' });
  work = records.setBody(work.workId, work.revision, 'brief', 'Private brief.');
  records.recordGate(work.workId, work.revision, { briefDigest: records.gate(work.workId).briefDigest!, approvedBy: 'reviewer', evidence: 'Passed.' });
  const { client } = provider(); let body = 'Author description.\n';
  client.readBody = async () => ({ body, format: 'markdown', assigned: false, linkedPullRequest: false });
  client.writeBody = async (_ticket, _target, op) => { body = body.slice(0, op.location.start) + op.content + body.slice(op.location.end); };
  const engine = publicationEngine(records, { provider: client, settings: async (repo) => settings(repo) });
  const first = await engine.prepare(work.workId, { documents: [document(work.workId)] });
  expect(first.operations[0]).toMatchObject({ kind: 'append', expectedText: '', location: { kind: 'body', start: 20, end: 20 } });
  records.approvePublication(work.workId, first.planId, first.revision, first.digest, 'person');
  expect((await engine.execute(work.workId, first.planId, 'cli')).successful).toHaveLength(1);
  const section = records.lastPublished(work.workId)[0]!.text;
  expect(body).toBe('Author description.\n' + section);
  expect(section).toContain('Refined description'); expect(section).not.toMatch(/factory|workId|<!-- lar/);
  body = 'Teammate introduction.\n' + body + '\nTeammate ending.';
  const update = await engine.prepare(work.workId, { documents: [{ ...document(work.workId), change: 'Add a case insensitive filter.' }], replaces: first.planId });
  expect(update.operations).toHaveLength(1);
  expect(update.operations[0]).toMatchObject({ kind: 'replace', expectedText: section });
  records.approvePublication(work.workId, update.planId, update.revision, update.digest, 'person');
  await engine.execute(work.workId, update.planId, 'cli');
  expect(body).toMatch(/^Teammate introduction.\nAuthor description.\n/);
  expect(body).toMatch(/\nTeammate ending.$/); expect(body).toContain('Add a case insensitive filter.');
});

it('updates a build published by its concept without treating a relationship comment as its description', async () => {
  const { records } = await fixture(); let concept = records.create({ title: 'Search', repository: 'team/app', kind: 'concept' }); const build = await passing(records);
  records.setParent(build.workId, build.revision, concept.workId);
  concept = records.setBody(concept.workId, records.read(concept.workId).revision, 'map', 'Private destination.'); records.setFogGone(concept.workId, concept.revision, true);
  const { client } = provider(); client.relate = async () => { throw new PublicationRefused('HTTP 403 relationships refused.'); };
  const engine = publicationEngine(records, { provider: client, settings: async (repo) => settings(repo) });
  const plan = await engine.prepare(concept.workId, { documents: [document(concept.workId), document(build.workId)] });
  records.approvePublication(concept.workId, plan.planId, plan.revision, plan.digest, 'person'); await engine.execute(concept.workId, plan.planId, 'cli');
  const fallback = await engine.fallback(concept.workId, plan.planId);
  records.approvePublication(concept.workId, fallback.planId, fallback.revision, fallback.digest, 'person'); await engine.execute(concept.workId, fallback.planId, 'cli');
  client.readBody = async () => ({ body: plan.tickets[1]!.body, format: 'markdown', assigned: false, linkedPullRequest: false });
  client.findComments = async () => [{ commentId: 'comment-1', content: 'Part of https://github.com/team/app/issues/1' }];
  const update = await engine.prepare(build.workId, { documents: [{ ...document(build.workId), change: 'Filter by prefix.' }] });
  expect(update.operations[0]).toMatchObject({ kind: 'replace', expectedText: plan.tickets[1]!.body });
});

it('updates a fully published concept and builds without repeating their completed relationships', async () => {
  const { records } = await fixture(); let concept = records.create({ title: 'Search', repository: 'team/app', kind: 'concept' }); const build = await passing(records);
  records.setParent(build.workId, build.revision, concept.workId);
  concept = records.setBody(concept.workId, records.read(concept.workId).revision, 'map', 'Private destination.'); records.setFogGone(concept.workId, concept.revision, true);
  const { client, writes } = provider(); const engine = publicationEngine(records, { provider: client, settings: async (repo) => settings(repo) });
  const plan = await engine.prepare(concept.workId, { documents: [document(concept.workId), document(build.workId)] });
  records.approvePublication(concept.workId, plan.planId, plan.revision, plan.digest, 'person'); await engine.execute(concept.workId, plan.planId, 'cli');
  const bodies = new Map(plan.tickets.map((t) => [t.workId, t.body]));
  client.readBody = async (ticket) => ({ body: bodies.get(ticket.workId)!, format: 'markdown', assigned: false, linkedPullRequest: false });
  client.writeBody = async (ticket, _target, op) => { const body = bodies.get(ticket.workId)!; bodies.set(ticket.workId, body.slice(0, op.location.start) + op.content + body.slice(op.location.end)); };
  const update = await engine.prepare(concept.workId, { replaces: plan.planId, documents: [concept, build].map((r) => ({ ...document(r.workId), change: 'Filter by prefix.' })) });
  expect(update.operations.map((op) => op.kind)).toEqual(['replace', 'replace']);
  records.approvePublication(concept.workId, update.planId, update.revision, update.digest, 'person'); await engine.execute(concept.workId, update.planId, 'cli');
  expect(writes.map((w) => w.kind)).toEqual(['create', 'create', 'relationship']);
  expect(records.publication(concept.workId, plan.planId).results.at(-1)!.status).toBe('successful');
  const next = await engine.prepare(concept.workId, { replaces: update.planId, documents: [concept, build].map((r) => document(r.workId)) });
  expect(next.operations.map((op) => op.kind)).toEqual(['replace', 'replace']);
});

it('recovers an exact supplied URL when provider search is refused without creating again', async () => {
  const { records } = await fixture(); const work = await passing(records); const { client, writes } = provider();
  client.create = async (ticket) => { writes.push({ ticket, kind: 'create' }); throw new Error('Lost creation response.'); };
  const engine = publicationEngine(records, { settings: async (repo) => settings(repo), provider: client });
  const plan = await engine.prepare(work.workId, { documents: [document(work.workId)] });
  records.approvePublication(work.workId, plan.planId, plan.revision, plan.digest, 'person');
  await engine.execute(work.workId, plan.planId, 'board');
  client.search = async () => { throw new Error('Search refused.'); };
  const target = { ticket: 'team/app#19', url: 'https://github.com/team/app/issues/19' };
  client.inspect = async () => ({ ...target, title: plan.tickets[0]!.title, body: plan.tickets[0]!.body, type: 'Task', labels: ['Search'] });
  const result = await engine.reconcile(work.workId, plan.planId, 'person', [{ operationId: `create:${work.workId}`, ...target }]);
  expect(result.uncertain).toEqual([]);
  expect(result.successful).toEqual([`create:${work.workId}`]);
  expect(writes).toHaveLength(1);
});

it('retry previews only outstanding writes while preserving successful creations and requiring fresh approval', async () => {
  const { records } = await fixture(); let concept = records.create({ title: 'Search everywhere', repository: 'team/app', kind: 'concept' });
  const build = await passing(records); records.setParent(build.workId, build.revision, concept.workId);
  concept = records.setBody(concept.workId, records.read(concept.workId).revision, 'map', 'Destination.'); records.setFogGone(concept.workId, concept.revision, true);
  const { client, writes } = provider(); let refused = true;
  client.relate = async (ticket) => { if (refused) throw new PublicationRefused('Relationship refused.'); writes.push({ ticket, kind: 'relationship' }); };
  const engine = publicationEngine(records, { settings: async (repo) => settings(repo), provider: client });
  const plan = await engine.prepare(concept.workId, { documents: [document(concept.workId), document(build.workId)] });
  records.approvePublication(concept.workId, plan.planId, plan.revision, plan.digest, 'person');
  await engine.execute(concept.workId, plan.planId, 'board');
  const retry = await engine.retry(concept.workId, plan.planId);
  expect(retry.approval).toBeNull();
  expect(retry.results.map((item) => item.status)).toEqual(['successful', 'successful', 'pending']);
  refused = false;
  await engine.execute(concept.workId, retry.planId, 'board');
  expect(writes.map((item) => item.kind)).toEqual(['create', 'create']);
  records.approvePublication(concept.workId, retry.planId, retry.revision, retry.digest, 'person');
  await engine.execute(concept.workId, retry.planId, 'board');
  expect(writes.map((item) => item.kind)).toEqual(['create', 'create', 'relationship']);
});

it('a refused creation can become a read-only handover without another create attempt', async () => {
  const { records } = await fixture(); const work = await passing(records); const { client, writes } = provider();
  client.create = async () => { throw new PublicationRefused('Creation permission refused.'); };
  const engine = publicationEngine(records, { settings: async (repo) => settings(repo), provider: client });
  const plan = await engine.prepare(work.workId, { documents: [document(work.workId)] });
  records.approvePublication(work.workId, plan.planId, plan.revision, plan.digest, 'person');
  await engine.execute(work.workId, plan.planId, 'board');
  const handover = await engine.fallback(work.workId, plan.planId, 'handover');
  expect(handover.operations).toEqual([]);
  expect(records.publicationHandover(work.workId, handover.planId)).toContain('Use a prefix match. Keep results predictable.');
  expect(writes).toEqual([]);
});

it('a textual relationship refusal permits a handover containing the exact relationship URLs', async () => {
  const { records } = await fixture(); let concept = records.create({ title: 'Search everywhere', repository: 'team/app', kind: 'concept' });
  const build = await passing(records); records.setParent(build.workId, build.revision, concept.workId);
  concept = records.setBody(concept.workId, records.read(concept.workId).revision, 'map', 'Destination.'); records.setFogGone(concept.workId, concept.revision, true);
  const { client } = provider();
  client.relate = async () => { throw new PublicationRefused('Native relationship refused.'); };
  client.comment = async () => { throw new PublicationRefused('Comment refused.'); };
  const engine = publicationEngine(records, { settings: async (repo) => settings(repo), provider: client });
  let plan = await engine.prepare(concept.workId, { documents: [document(concept.workId), document(build.workId)] });
  records.approvePublication(concept.workId, plan.planId, plan.revision, plan.digest, 'person');
  await engine.execute(concept.workId, plan.planId, 'board');
  plan = await engine.fallback(concept.workId, plan.planId);
  records.approvePublication(concept.workId, plan.planId, plan.revision, plan.digest, 'person');
  await engine.execute(concept.workId, plan.planId, 'board');
  const handover = await engine.fallback(concept.workId, plan.planId);
  expect(handover.operations.filter((op) => op.kind !== 'create')).toEqual([]);
  expect(records.publicationHandover(concept.workId, handover.planId)).toContain('Part of https://github.com/team/app/issues/1');
});

it('requires build completion checks for initial and replacement documents', async () => {
  const { records } = await fixture(); const work = await passing(records);
  const engine = publicationEngine(records, { provider: provider().client, settings: async (repo) => settings(repo) });
  await expect(engine.prepare(work.workId, { documents: [{ ...document(work.workId), checks: [] }] })).rejects.toThrow(/completion check/i);
  const plan = await engine.prepare(work.workId, { documents: [document(work.workId)] });
  await expect(engine.prepare(work.workId, { documents: [{ ...document(work.workId), checks: [] }], replaces: plan.planId })).rejects.toThrow(/completion check/i);
});

it('previews and resumes an Azure handover without a mapped type, write consent or metadata access', async () => {
  const { records } = await fixture(); const work = await passing(records, 'contoso/project/app'); const { client, writes } = provider();
  const config = settings(work.repository);
  config.setup.itemSource = { kind: 'azure-board', team: 'Team' }; config.discovery.provider = 'azure';
  config.setup.vocabulary = effectiveVocabulary({ build: { type: null, labels: ['Search'] } }).vocabulary;
  config.discovery.types = { state: 'refused', reason: 'Read-only account.' }; config.discovery.labels = { state: 'refused', reason: 'Read-only account.' };
  config.setup.consent = [];
  const engine = publicationEngine(records, { provider: client, settings: async () => config });
  const plan = await engine.prepare(work.workId, { documents: [document(work.workId)], delivery: { [work.workId]: 'handover' } });
  expect(plan.operations).toEqual([]);
  expect(plan.tickets[0]).toMatchObject({ typeResolution: { selected: null }, vocabulary: { build: { labels: ['Search'] } } });
  records.approvePublication(work.workId, plan.planId, plan.revision, plan.digest, 'person');
  expect(await engine.resume(work.workId, plan.planId, 'cli')).toMatchObject({ current: true, next: null });
  expect(records.publicationHandover(work.workId, plan.planId)).toContain('A saved search appears for its name.');
  expect(writes).toEqual([]);
});

it('coalesces settings per repository during preview and inspection of ten builds', async () => {
  const { records } = await fixture(); let concept = records.create({ title: 'Search', repository: 'team/app', kind: 'concept' });
  const builds = await Promise.all(Array.from({ length: 10 }, () => passing(records)));
  for (const build of builds) records.setParent(build.workId, build.revision, concept.workId);
  concept = records.setBody(concept.workId, records.read(concept.workId).revision, 'map', 'Private destination.'); records.setFogGone(concept.workId, concept.revision, true);
  const { client, writes } = provider(); let reads = 0;
  const engine = publicationEngine(records, { provider: client, settings: async (repo) => { reads++; return settings(repo); } });
  const plan = await engine.prepare(concept.workId, { documents: [concept, ...builds].map((work) => document(work.workId)) });
  expect(reads).toBe(1);
  reads = 0;
  await engine.inspect(concept.workId, plan.planId);
  expect(reads).toBe(1);
  expect(writes).toEqual([]);
  reads = 0;
  records.approvePublication(concept.workId, plan.planId, plan.revision, plan.digest, 'person');
  const result = await engine.execute(concept.workId, plan.planId, 'cli');
  expect(result.successful).toHaveLength(21);
  expect(reads).toBeLessThanOrEqual(43);
});

it.each(['refused', 'no consent'] as const)('checks the parent repository before a cross-repository GitHub child link when parent access has %s', async (restriction) => {
  const { records } = await fixture(); let concept = records.create({ title: 'Search', repository: 'team/parent', kind: 'concept' }); const build = await passing(records, 'team/child');
  records.setParent(build.workId, build.revision, concept.workId); concept = records.setBody(concept.workId, records.read(concept.workId).revision, 'map', 'Private destination.'); records.setFogGone(concept.workId, concept.revision, true);
  const { client, writes } = provider();
  const engine = publicationEngine(records, { provider: client, settings: async (repo) => {
    const config = settings(repo);
    if (repo === 'team/parent') {
      if (restriction === 'refused') config.setup.access['relate-ticket'] = 'refused';
      else config.setup.consent = config.setup.consent.filter((op) => op !== 'relate-ticket');
    }
    return config;
  } });
  const preview = await engine.prepare(concept.workId, { documents: [concept, build].map((work) => document(work.workId)), delivery: { [concept.workId]: 'handover', [build.workId]: 'handover' } });
  const plan = records.proposePublication(concept.workId, records.read(concept.workId).revision, { replaces: preview.planId, sources: preview.sources.map(({ workId, revision }) => ({ workId, revision })), tickets: preview.tickets.map((ticket) => ({ ...ticket,
    destination: { ...ticket.destination, ticket: `${ticket.destination.repository}#1`, url: `https://github.com/${ticket.destination.repository}/issues/1` } })),
    operations: [{ kind: 'relationship', operationId: 'child', ticketWorkId: build.workId, relatedWorkId: concept.workId, relationship: 'child', dependsOn: [] }] });
  records.approvePublication(concept.workId, plan.planId, plan.revision, plan.digest, 'person');
  expect(await engine.execute(concept.workId, plan.planId, 'cli')).toMatchObject({ current: false, reasons: expect.arrayContaining([expect.stringContaining('team/parent needs separate consent')]) });
  expect(records.publication(concept.workId, plan.planId).results[0]?.status).toBe('pending');
  expect(writes).toEqual([]);
  const fallback = await engine.fallback(concept.workId, plan.planId);
  expect(fallback.operations).toEqual([expect.objectContaining({ kind: 'textual-relationship', content: 'Part of https://github.com/team/parent/issues/1' })]);
});

it.each([
  ['github', 'labels'], ['github', 'type'], ['azure', 'labels'], ['azure', 'type'], ['azure', 'body'], ['azure', 'title'], ['azure', 'format'],
] as const)('retains the created %s receipt and stops on a stored %s discrepancy without recreating', async (platform, mismatch) => {
  const { records, path } = await fixture(); const repository = platform === 'github' ? 'team/app' : 'contoso/project/app';
  const work = await passing(records, repository); const config = settings(repository);
  config.discovery.provider = platform;
  if (platform === 'azure') config.setup.itemSource = { kind: 'azure-board', team: 'Team' };
  let creates = 0; let approved: PublicationTicket;
  const raw = () => platform === 'github' ? { number: 12, html_url: 'https://github.com/team/app/issues/12', title: approved.title, body: approved.body,
    type: mismatch === 'type' ? null : { name: 'Task' }, labels: mismatch === 'labels' ? [] : [{ name: 'Search' }] }
    : { id: 12, fields: { 'System.Title': mismatch === 'title' ? 'Altered title' : approved.title, 'System.Description': mismatch === 'body' ? 'Altered body' : approved.body,
      'System.WorkItemType': mismatch === 'type' ? 'Bug' : 'Task', 'System.Tags': mismatch === 'labels' ? '' : 'Search' },
      multilineFieldsFormat: { 'System.Description': mismatch === 'format' ? 'HTML' : 'Markdown' } };
  const assertReceipt = () => {
    expect(records.publication(work.workId, plan.planId).results[0]?.attempt).toMatchObject({ status: 'successful', ticket: `${repository}#12` });
  };
  const adapter = publicationProvider({ github: async (args) => {
    if (args.includes('POST')) { creates++; return JSON.stringify(raw()); }
    assertReceipt(); return JSON.stringify(raw());
  }, azure: async (args) => {
    if (args.includes('workitems')) { creates++; return JSON.stringify(raw()); }
    assertReceipt(); return JSON.stringify({ value: [raw()] });
  } });
  const engine = publicationEngine(records, { provider: adapter, settings: async () => config });
  const plan = await engine.prepare(work.workId, { documents: [document(work.workId)] }); approved = plan.tickets[0]!;
  records.approvePublication(work.workId, plan.planId, plan.revision, plan.digest, 'person');
  const result = await engine.execute(work.workId, plan.planId, 'cli');
  expect(result).toMatchObject({ current: false, successful: [`create:${work.workId}`], failed: [], uncertain: [], reasons: expect.arrayContaining([expect.stringMatching(/verification.*approved correction/i)]) });
  expect(records.lastPublished(work.workId)).toEqual([]);
  expect(records.publicationEvidence(work.workId, plan.planId).map((item) => item.evidence).join('\n')).toMatch(/discrepancy/i);
  const reopened = await openWorkRecords(path); opened.push(reopened);
  await publicationEngine(reopened, { provider: adapter, settings: async () => config }).resume(work.workId, plan.planId, 'cli');
  const replacement = await engine.prepare(work.workId, { documents: [document(work.workId)], replaces: plan.planId, delivery: { [work.workId]: 'handover' } });
  expect(replacement.tickets[0]?.destination.ticket).toBe(`${repository}#12`);
  expect(replacement.operations.some((op) => op.kind === 'create')).toBe(false);
  expect(creates).toBe(1);
});

it('keeps creation successful when verification is refused and resumes only inspection after restart', async () => {
  const { records, path } = await fixture(); const work = await passing(records); const { client, writes } = provider();
  const inspect = client.inspect;
  client.inspect = async () => { throw new PublicationRefused('HTTP 403 inspection refused.'); };
  const engine = publicationEngine(records, { provider: client, settings: async (repo) => settings(repo) });
  const plan = await engine.prepare(work.workId, { documents: [document(work.workId)] });
  records.approvePublication(work.workId, plan.planId, plan.revision, plan.digest, 'person');
  expect(await engine.execute(work.workId, plan.planId, 'cli')).toMatchObject({ current: false, successful: [`create:${work.workId}`], failed: [], uncertain: [] });
  expect(records.publication(work.workId, plan.planId).results[0]?.attempt).toMatchObject({ ticket: 'team/app#1', verification: { status: 'discrepancy', evidence: expect.stringContaining('inspection refused') }, location: null });
  expect(records.lastPublished(work.workId)).toEqual([]);
  const reopened = await openWorkRecords(path); opened.push(reopened); client.inspect = inspect;
  const result = await publicationEngine(reopened, { provider: client, settings: async (repo) => settings(repo) }).resume(work.workId, plan.planId, 'cli');
  expect(result).toMatchObject({ current: true, next: null, failed: [], uncertain: [] });
  expect(result.plan.results[0]?.attempt?.verification?.status).toBe('verified');
  expect(reopened.lastPublished(work.workId)[0]?.text).toBe(plan.tickets[0]?.body);
  expect(writes).toHaveLength(1);
});

describe("a Dependency's request", () => {
  const request = (dependencyId: string, change = 'Add a name filter to the search endpoint.') => ({ dependencyId, title: 'Search endpoint name filter', change,
    reason: 'The app finds saved searches by name.', contract: 'GET /searches?name= returns the matching searches.', checks: ['A name query returns only matching searches.'] });
  async function blocked(records: WorkRecords) {
    const work = await passing(records);
    const dependency = records.addDependency(work.workId, { need: 'A name filter on the search endpoint.', owner: 'other/api', handover: 'Ask the API team for a name filter.' });
    records.addDependencyBlock(dependency.dependencyId, dependency.revision, work.workId);
    return { work, dependencyId: dependency.dependencyId };
  }
  // Only team/app is onboarded; the owning team's repository uses plain terms.
  const onboarded = async (repo: string) => repo === 'team/app' ? settings(repo) : Promise.reject(new Error(`${repo} is not on this Mac's list.`));
  const allowed = (repo: string) => repo === 'team/app';
  const sources = (records: WorkRecords, workId: string) => records.publicationReadiness(workId).sources.map(({ workId, revision }) => ({ workId, revision }));

  it('creates the request once, links the build to it and later yields only revised handover text', async () => {
    const { records } = await fixture(); const { work, dependencyId } = await blocked(records); const { client, writes } = provider();
    const engine = publicationEngine(records, { settings: onboarded, allowed, provider: client });
    const plan = await engine.prepare(work.workId, { documents: [document(work.workId)], dependencies: [request(dependencyId)] });
    expect(plan.tickets[1]).toMatchObject({ workId: dependencyId, dependencyOf: work.workId, destination: { repository: 'other/api' }, vocabulary: {}, settingsSnapshot: 'not-onboarded',
      body: '## Change\n\nAdd a name filter to the search endpoint.\n\n## Reason\n\nThe app finds saved searches by name.\n\n## Contract\n\nGET /searches?name= returns the matching searches.\n\n## Delivery checks\n\n- A name query returns only matching searches.' });
    expect(plan.operations.map((op) => op.kind)).toEqual(['create', 'create', 'relationship']);
    records.approvePublication(work.workId, plan.planId, plan.revision, plan.digest, 'person');
    const before = { holder: records.read(work.workId).revision, dependency: records.dependency(dependencyId).revision };
    expect((await engine.execute(work.workId, plan.planId, 'cli')).successful).toHaveLength(3);
    expect(writes.map((w) => w.kind)).toEqual(['create', 'create', 'relationship']);
    expect(records.dependency(dependencyId)).toMatchObject({ ticket: 'other/api#2', revision: before.dependency + 1 });
    expect(records.read(work.workId).revision).toBe(before.holder + 1);

    await expect(engine.prepare(work.workId, { documents: [document(work.workId)], dependencies: [request(dependencyId)], delivery: { [work.workId]: 'handover', [dependencyId]: 'comment' }, replaces: plan.planId }))
      .rejects.toThrow(/already has the request/);
    const correction = await engine.prepare(work.workId, { documents: [document(work.workId)], dependencies: [request(dependencyId, 'Add a name and owner filter.')],
      delivery: { [work.workId]: 'handover' }, replaces: plan.planId });
    expect(correction.operations).toEqual([]);
    const handover = records.publicationHandover(work.workId, correction.planId);
    expect(handover).toContain('Add a name and owner filter.\n\n## Reason');
    expect(handover).toContain('## Requested by\n\n- https://github.com/team/app/issues/1');
    expect(handover).toContain('Depends on https://github.com/other/api/issues/2');
    expect(() => records.proposePublication(work.workId, records.read(work.workId).revision, { tickets: correction.tickets, sources: sources(records, work.workId), replaces: correction.planId,
      operations: [{ kind: 'comment', operationId: 'again', ticketWorkId: dependencyId, dependsOn: [], content: 'Add a name and owner filter.' }] })).toThrow(/already has the request/);
    expect(writes).toHaveLength(3);
  });

  it('falls back from a refused link to a Depends on line, then to handover, keeping the blocker and handover', async () => {
    const { records } = await fixture(); const { work, dependencyId } = await blocked(records); const { client, writes } = provider();
    client.relate = async () => { throw new PublicationRefused('HTTP 403 link refused.'); };
    const engine = publicationEngine(records, { settings: onboarded, allowed, provider: client });
    const plan = await engine.prepare(work.workId, { documents: [document(work.workId)], dependencies: [request(dependencyId)] });
    records.approvePublication(work.workId, plan.planId, plan.revision, plan.digest, 'person');
    expect((await engine.execute(work.workId, plan.planId, 'cli')).failed).toEqual([`blocked-by:${work.workId}:${dependencyId}`]);
    const line = await engine.fallback(work.workId, plan.planId);
    expect(line.operations.at(-1)).toMatchObject({ kind: 'textual-relationship', ticketWorkId: work.workId, content: 'Depends on https://github.com/other/api/issues/2' });
    client.comment = async () => { throw new PublicationRefused('HTTP 403 comment refused.'); };
    records.approvePublication(work.workId, line.planId, line.revision, line.digest, 'person');
    expect((await engine.execute(work.workId, line.planId, 'cli')).failed).toHaveLength(1);
    const handover = await engine.fallback(work.workId, line.planId);
    expect(handover.results.every((result) => result.status === 'successful')).toBe(true);
    expect(records.publicationHandover(work.workId, handover.planId)).toContain('Depends on https://github.com/other/api/issues/2');
    expect(records.dependency(dependencyId)).toMatchObject({ blocks: [work.workId], handover: 'Ask the API team for a name filter.', met: null });
    expect(writes.map((w) => w.kind)).toEqual(['create', 'create']);
  });

  it('recovers a lost creation response without posting the request twice', async () => {
    const { records } = await fixture(); const { work, dependencyId } = await blocked(records); const { client, writes } = provider(); const create = client.create;
    client.create = async (ticket) => { const made = await create(ticket); if (ticket.dependencyOf) throw new Error('Connection lost after creation.'); return made; };
    const engine = publicationEngine(records, { settings: onboarded, allowed, provider: client });
    const plan = await engine.prepare(work.workId, { documents: [document(work.workId)], dependencies: [request(dependencyId)] });
    records.approvePublication(work.workId, plan.planId, plan.revision, plan.digest, 'person');
    expect((await engine.execute(work.workId, plan.planId, 'cli')).uncertain).toEqual([`create:${dependencyId}`]);
    expect((await engine.resume(work.workId, plan.planId, 'board')).uncertain).toHaveLength(1);
    expect(records.dependency(dependencyId).ticket).toBeNull();
    client.search = async () => [{ ticket: 'other/api#2', url: 'https://github.com/other/api/issues/2' }];
    expect(await engine.reconcile(work.workId, plan.planId, 'person', [{ operationId: `create:${dependencyId}`, ticket: 'other/api#2' }])).toMatchObject({ uncertain: [] });
    expect(records.dependency(dependencyId).ticket).toBe('other/api#2');
    expect((await engine.resume(work.workId, plan.planId, 'board')).successful).toHaveLength(3);
    expect(writes.map((w) => w.kind)).toEqual(['create', 'create', 'relationship']);
  });

  it("comments the request on the team's ticket with its onboarded Vocabulary only when chosen", async () => {
    const { records } = await fixture(); const { work, dependencyId } = await blocked(records); const { client } = provider();
    records.updateDependency(dependencyId, records.dependency(dependencyId).revision, { ticket: 'other/api#7' });
    const engine = publicationEngine(records, { settings: async (repo) => settings(repo), allowed: () => true, provider: client });
    const handover = await engine.prepare(work.workId, { documents: [document(work.workId)], dependencies: [request(dependencyId)] });
    expect(handover.operations.filter((op) => op.ticketWorkId === dependencyId)).toEqual([]);
    expect(handover.tickets[1]).toMatchObject({ destination: { ticket: 'other/api#7', url: 'https://github.com/other/api/issues/7' }, vocabulary: { build: { type: 'Task', labels: ['Search'] } } });
    const posted = await engine.prepare(work.workId, { documents: [document(work.workId)], dependencies: [request(dependencyId)], delivery: { [dependencyId]: 'comment' }, replaces: handover.planId });
    expect(posted.operations.map((op) => `${op.kind}:${op.ticketWorkId === dependencyId ? 'request' : 'build'}`)).toEqual(['create:build', 'comment:request', 'relationship:build']);
  });

  it("never writes to an onboarded owner whose settings can't be read", async () => {
    const { records } = await fixture(); const { work, dependencyId } = await blocked(records); const { client, writes } = provider();
    const listed = new Set(['team/app']);
    const failing = async (repo: string) => repo === 'team/app' ? settings(repo) : Promise.reject(new Error('gh: HTTP 502 reading other/api.'));
    const engine = publicationEngine(records, { settings: failing, allowed: (repo) => listed.has(repo), provider: client });
    const plan = await engine.prepare(work.workId, { documents: [document(work.workId)], dependencies: [request(dependencyId)] });
    records.approvePublication(work.workId, plan.planId, plan.revision, plan.digest, 'person');
    listed.add('other/api');
    await expect(engine.prepare(work.workId, { documents: [document(work.workId)], dependencies: [request(dependencyId)], replaces: plan.planId })).rejects.toThrow('HTTP 502');
    const result = await engine.execute(work.workId, plan.planId, 'cli');
    expect(result).toMatchObject({ current: false, successful: [] });
    expect(result.reasons.join(' ')).toContain('HTTP 502');
    expect(writes).toEqual([]);
  });
});
