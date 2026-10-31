import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { normalizeItems } from '@lar-factory/shared';
import { boardIssue } from '@lar-factory/shared/test/raw-items';
import { DEFAULT_RETENTION, openWorkRecords, type WorkRecords } from '@lar-factory/work-records';
import { archivedItems, recordItems } from './record-items.ts';

const REPO = 'maddec01/lar-factory';
const opened: { records: WorkRecords; dir: string }[] = [];
afterEach(() => {
  for (const { records, dir } of opened.splice(0)) {
    records.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
async function open(): Promise<WorkRecords> {
  const dir = mkdtempSync(join(tmpdir(), 'record-items-'));
  const records = await openWorkRecords(join(dir, 'work-records.db'));
  opened.push({ records, dir });
  return records;
}
const tickets = (...issues: Parameters<typeof boardIssue>[]) => normalizeItems(issues.map((args) => boardIssue(...args)));

test('only recorded work in an onboarded repository is a board item, named by its work ID', async () => {
  const records = await open();
  const recorded = records.importTicket({ title: 'Recorded', repository: REPO, kind: 'feature', status: 'Queued', ticket: `${REPO}#12` }).record;
  records.create({ title: 'Elsewhere', repository: 'maddec01/other', kind: 'bug' });
  const items = recordItems(records, tickets([12, 'List'], [13, 'Shaping']), [REPO]);
  assert.deepEqual(items.map((i) => [i.id, i.number, i.status, i.kind, i.revision]), [[recorded.workId, 12, 'Queued', 'feature', recorded.revision]]);
  assert.equal(items[0]!.url, `https://github.com/${REPO}/issues/12`);
});

test("a ticket edit never changes the record's Status, kind or title", async () => {
  const records = await open();
  records.importTicket({ title: 'Kept title', repository: REPO, kind: 'feature', status: 'Ready', ticket: `${REPO}#12` });
  const [item] = recordItems(records, tickets([12, 'Review', REPO, ['bug']]), [REPO]);
  assert.deepEqual([item!.status, item!.statuses, item!.kind, item!.title], ['Ready', ['Ready'], 'feature', 'Kept title']);
  assert.ok(item!.labels.includes('bug'), 'the ticket supplies its labels as context');
});

test('a ticketless record and a record whose ticket the read did not list show from the record alone', async () => {
  const records = await open();
  const local = records.create({ title: 'Local', repository: REPO, kind: 'improvement', status: 'Shaping' });
  records.importTicket({ title: 'Unread', repository: REPO, kind: 'bug', ticket: `${REPO}#40` });
  const items = recordItems(records, [], [REPO]);
  assert.deepEqual(items.map((i) => [i.title, i.number, i.url, i.status, i.state]), [['Local', 0, null, 'Shaping', 'open'], ['Unread', 40, null, 'List', 'open']]);
  assert.equal(items[0]!.id, local.workId);
});

test('set-aside work and slices are no board items; a Done record is closed as done', async () => {
  const records = await open();
  const build = records.create({ title: 'Build', repository: REPO, kind: 'build', status: 'Done' });
  const aside = records.create({ title: 'Aside', repository: REPO, kind: 'bug' });
  records.setAside(aside.workId, aside.revision);
  const slice = records.create({ title: 'Slice', repository: REPO, kind: 'slice' });
  records.setParent(slice.workId, slice.revision, build.workId);
  const items = recordItems(records, [], [REPO]);
  assert.deepEqual(items.map((i) => [i.title, i.state, i.closedAs]), [['Build', 'closed', 'done']]);
});

test('finished work retention hides leaves the board for Archive, and set-aside work is in Archive until Restore brings it back', async () => {
  const records = await open();
  const finished = records.create({ title: 'Finished', repository: REPO, kind: 'build', status: 'Done' });
  records.recordFinished(finished.workId, finished.revision);
  const aside = records.importTicket({ title: 'Aside', repository: REPO, kind: 'bug', ticket: `${REPO}#12` }).record;
  records.setAside(aside.workId, aside.revision);
  const read = tickets([12, 'List']);
  const week = new Set(records.hidden(DEFAULT_RETENTION).map((r) => r.workId));
  assert.deepEqual(recordItems(records, read, [REPO], [], week).map((i) => i.title), ['Finished'], 'finished work stays for seven days');
  const later = new Set(records.hidden(DEFAULT_RETENTION, new Date(Date.now() + 8 * 86_400_000)).map((r) => r.workId));
  assert.deepEqual(recordItems(records, read, [REPO], [], later), []);
  assert.deepEqual(archivedItems(records, read, [REPO], later).map((i) => [i.title, i.archived]), [
    ['Finished', { setAside: false, hidden: true, ticketOpen: false }],
    ['Aside', { setAside: true, hidden: true, ticketOpen: true }],
  ]);
  records.restore(aside.workId, records.read(aside.workId).revision);
  assert.deepEqual(recordItems(records, read, [REPO], [], new Set(records.hidden(DEFAULT_RETENTION).map((r) => r.workId))).map((i) => i.title), ['Finished', 'Aside']);
});

test("a record's structure, blockers and slices come from records", async () => {
  const records = await open();
  const concept = records.create({ title: 'Concept', repository: REPO, kind: 'concept', status: 'Shaping' });
  let build = records.create({ title: 'Build', repository: REPO, kind: 'build', status: 'In progress' });
  build = records.setParent(build.workId, build.revision, concept.workId);
  const blocker = records.importTicket({ title: 'Blocker', repository: REPO, kind: 'decision', ticket: `${REPO}#5` }).record;
  build = records.addBlocker(build.workId, build.revision, blocker.workId);
  const slice = records.create({ title: 'First slice', repository: REPO, kind: 'slice', status: 'In progress' });
  records.setParent(slice.workId, slice.revision, build.workId);
  records.setBody(concept.workId, records.read(concept.workId).revision, 'map', '## Destination\n\nWhere it goes.\n\n## Fog\n\n- What is left\n');
  const items = recordItems(records, [], [REPO]);
  const shown = (title: string) => items.find((i) => i.title === title)!;
  assert.equal(shown('Build').parentId, concept.workId);
  assert.deepEqual(shown('Build').parent && [shown('Build').parent!.title, shown('Build').parent!.number], ['Concept', 0]);
  assert.deepEqual(shown('Build').blockers, [{ number: 5, repo: REPO, state: 'open', workId: blocker.workId, title: 'Blocker' }]);
  assert.deepEqual(shown('Build').slices.map((s) => [s.title, s.progress]), [['First slice', 'active']]);
  assert.deepEqual(shown('Concept').subIssues, { total: 1, completed: 0 });
  assert.deepEqual(shown('Concept').map, { destination: 'Where it goes.', decisions: [], fog: ['What is left'] });
});

test("only the record's blockers hold it: its ticket's provider blockers never do", async () => {
  const records = await open();
  records.importTicket({ title: 'Ticketed', repository: REPO, kind: 'feature', status: 'Queued', ticket: `${REPO}#12` });
  const [ticket] = tickets([12, 'Queued']);
  const [item] = recordItems(records, [{ ...ticket!, blockers: [{ number: 11, repo: REPO, state: 'open' }] }], [REPO]);
  assert.deepEqual(item!.blockers, []);
});

test('a Dependency blocking a build is one of its blockers, open until the user marks it met, whatever its ticket shows', async () => {
  const records = await open();
  const concept = records.create({ title: 'Concept', repository: REPO, kind: 'concept', status: 'Shaping' });
  const build = records.create({ title: 'Build', repository: REPO, kind: 'build', status: 'Ready' });
  records.setParent(build.workId, build.revision, concept.workId);
  let dependency = records.addDependency(concept.workId, { need: 'An export endpoint', owner: 'server team', evidence: 'It answers in staging',
    ticket: 'maddec01/lar-server#40', pullRequests: ['maddec01/lar-server#41'] });
  dependency = records.addDependencyBlock(dependency.dependencyId, dependency.revision, build.workId);
  dependency = records.observeDependency(dependency.dependencyId, dependency.revision, { subject: 'maddec01/lar-server#41', kind: 'open' });
  dependency = records.observeDependency(dependency.dependencyId, dependency.revision, { subject: 'maddec01/lar-server#40', kind: 'closed' });
  const shown = () => recordItems(records, [], [REPO]).find((i) => i.id === build.workId)!.blockers;
  const [blocker] = shown();
  assert.deepEqual({ ...blocker, dependency: { ...blocker!.dependency, observation: { ...blocker!.dependency!.observation, observedAt: '' } } }, {
    number: 40, repo: 'maddec01/lar-server', state: 'open', title: 'An export endpoint', dependency: {
      dependencyId: dependency.dependencyId, revision: dependency.revision, owner: 'server team', need: 'An export endpoint',
      ticket: 'maddec01/lar-server#40', named: [{ reference: 'maddec01/lar-server#40', url: 'https://github.com/maddec01/lar-server/issues/40' },
        { reference: 'maddec01/lar-server#41', url: 'https://github.com/maddec01/lar-server/pull/41' }],
      evidence: 'It answers in staging', met: null, needsReview: false,
      observation: { subject: 'maddec01/lar-server#40', kind: 'closed', detail: null, observedAt: '', lastGood: null } } });
  dependency = records.markDependencyMet(dependency.dependencyId, dependency.revision, 'pedro');
  assert.deepEqual(shown().map((b) => [b.state, b.dependency!.met?.by]), [['closed', 'pedro']]);
  records.observeDependency(dependency.dependencyId, dependency.revision, { subject: 'maddec01/lar-server#40', kind: 'reopened' });
  assert.deepEqual(shown().map((b) => [b.state, b.dependency!.needsReview]), [['closed', true]], 'a changed observation asks for a review and keeps the mark');
});

test("a Dependency's Azure work item and PR link to their pages", async () => {
  const records = await open();
  const build = records.create({ title: 'Build', repository: REPO, kind: 'build', status: 'Ready' });
  const API = 'contoso/Fabrikam%20Fiber/Web%20Api';
  const dependency = records.addDependency(build.workId, { need: 'An export endpoint', owner: API, ticket: `${API}#5`, pullRequests: [`${API}#9`] });
  records.addDependencyBlock(dependency.dependencyId, dependency.revision, build.workId);
  const [blocker] = recordItems(records, [], [REPO]).find((i) => i.id === build.workId)!.blockers;
  assert.deepEqual(blocker!.dependency!.named, [
    { reference: `${API}#5`, url: 'https://dev.azure.com/contoso/Fabrikam%20Fiber/_workitems/edit/5' },
    { reference: `${API}#9`, url: 'https://dev.azure.com/contoso/Fabrikam%20Fiber/_git/Web%20Api/pullrequest/9' },
  ]);
});

test("in a repository whose source hasn't read yet, only a record with a ticket waits for it", async () => {
  const records = await open();
  records.importTicket({ title: 'Unread', repository: REPO, kind: 'bug', ticket: `${REPO}#40` });
  records.create({ title: 'Local', repository: REPO, kind: 'feature' });
  assert.deepEqual(recordItems(records, [], [REPO], [REPO]).map((i) => i.title), ['Local']);
  assert.deepEqual(recordItems(records, tickets([40, 'List']), [REPO], [REPO]).map((i) => i.title), ['Unread', 'Local']);
});

test('work that needs you shows the reason, with what its PR and ticket observations offer', async () => {
  const records = await open();
  const build = records.create({ title: 'Build', repository: REPO, kind: 'build', status: 'Review' });
  let record = records.setPullRequest(build.workId, build.revision, `${REPO}#40`);
  record = records.observe(build.workId, record.revision, { of: 'pr', state: 'closed' });
  records.setNeedsYou(build.workId, record.revision, 'Its PR closed without merging.');
  const closed = records.importTicket({ title: 'Closed', repository: REPO, kind: 'bug', status: 'Queued', ticket: `${REPO}#12` }).record;
  records.setNeedsYou(closed.workId, records.observe(closed.workId, closed.revision, { of: 'ticket', state: 'closed' }).revision, 'Its ticket closed.');
  const reopened = records.importTicket({ title: 'Reopened', repository: REPO, kind: 'bug', status: 'Done', ticket: `${REPO}#13` }).record;
  records.setNeedsYou(reopened.workId, records.observe(reopened.workId, reopened.revision, { of: 'ticket', state: 'open' }).revision, 'Its ticket reopened.');
  const calm = records.create({ title: 'Calm', repository: REPO, kind: 'bug' });
  const shown = new Map(recordItems(records, [], [REPO]).map((item) => [item.id, item.needsYou]));
  assert.deepEqual(shown.get(build.workId), { reason: 'Its PR closed without merging.', offers: ['reopen-pr', 'replace-pr', 'set-aside'] });
  assert.deepEqual(shown.get(closed.workId), { reason: 'Its ticket closed.', offers: ['set-aside'] });
  assert.deepEqual(shown.get(reopened.workId), { reason: 'Its ticket reopened.', offers: ['reopen-work'] });
  assert.equal(shown.get(calm.workId), undefined);
});

test("an item-source change pauses only the repository's ticketed work, a domain-doc change its open work, each saying why", async () => {
  const records = await open();
  const ticketed = records.importTicket({ title: 'Ticketed', repository: REPO, kind: 'bug', status: 'Queued', ticket: `${REPO}#12` }).record;
  const local = records.create({ title: 'Local', repository: REPO, kind: 'build', status: 'Shaping' });
  const done = records.create({ title: 'Finished', repository: REPO, kind: 'build', status: 'Done' });
  const pausedBy = (paused: ('itemSource' | 'domainDocs')[]) =>
    new Map(recordItems(records, [], [REPO], [], new Set(), [{ repo: REPO, paused }]).map((item) => [item.id, item.paused]));
  const source = pausedBy(['itemSource']);
  assert.equal(source.get(ticketed.workId), "Its repository's item source changed. Accept the change in Settings › Repositories to go on.");
  assert.equal(source.get(local.workId), undefined);
  const docs = pausedBy(['domainDocs']);
  assert.equal(docs.get(local.workId), "Its repository's domain-doc location changed. Accept the change in Settings › Repositories to go on.");
  assert.equal(docs.get(done.workId), undefined, 'finished work has nothing left to write');
  assert.equal(pausedBy(['itemSource', 'domainDocs']).get(ticketed.workId),
    "Its repository's item source and domain-doc location changed. Accept the change in Settings › Repositories to go on.");
  assert.deepEqual([...pausedBy([]).values()], [undefined, undefined, undefined]);
});

test('publication eligibility follows finished refinement through Status changes and explains ineligible concepts and briefs', async () => {
  const records = await open();
  let build = records.create({ title: 'Ready to publish', repository: REPO, kind: 'build', status: 'Ready' });
  build = records.setBody(build.workId, build.revision, 'brief', 'Complete brief.');
  records.recordGate(build.workId, build.revision, { briefDigest: records.gate(build.workId).briefDigest!, approvedBy: 'reviewer', evidence: 'Passed.' });
  const decision = records.create({ title: 'Private decision', repository: REPO, kind: 'decision' });
  const concept = records.create({ title: 'Unfinished concept', repository: REPO, kind: 'concept' });
  const unfinished = records.create({ title: 'No gate', repository: REPO, kind: 'feature' });
  records.update(build.workId, records.read(build.workId).revision, { status: 'In progress' });
  const items = new Map(recordItems(records, [], [REPO]).map((item) => [item.id, item]));
  assert.deepEqual(items.get(build.workId)!.publication, { eligible: true, reasons: [] });
  assert.equal(items.get(decision.workId)!.publication, undefined);
  assert.ok(items.get(concept.workId)!.publication!.reasons.includes('The concept still has Fog.'));
  assert.ok(items.get(unfinished.workId)!.publication!.reasons.some((reason) => reason.includes('no current passing gate')));
});

test('publication history remains recoverable when a changed brief no longer has a passing gate', async () => {
  const records = await open();
  let build = records.create({ title: 'Search', repository: REPO, kind: 'build', status: 'Ready' });
  build = records.setBody(build.workId, build.revision, 'brief', 'Passed brief.');
  records.recordGate(build.workId, build.revision, { briefDigest: records.gate(build.workId).briefDigest!, approvedBy: 'reviewer', evidence: 'Passed.' });
  records.proposePublication(build.workId, build.revision, { tickets: [{ workId: build.workId, destination: { provider: 'github', repository: REPO }, vocabulary: {}, typeResolution: { candidates: [], selected: null }, title: 'Find searches', body: 'Find saved searches.' }],
    operations: [{ operationId: 'create', ticketWorkId: build.workId, kind: 'create', dependsOn: [] }], sources: records.publicationReadiness(build.workId).sources.map(({ workId, revision }) => ({ workId, revision })) });
  records.setBody(build.workId, build.revision, 'brief', 'Changed brief.');
  assert.equal(recordItems(records, [], [REPO])[0]!.publication!.eligible, false);
  assert.equal(recordItems(records, [], [REPO])[0]!.publication!.recoverable, true);
});
