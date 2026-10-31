import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { openWorkRecords, type PullRequestState, type WorkRecord, type WorkRecords } from '@lar-factory/work-records';
import { azureBoard } from '../azure/azure-board.ts';
import { fakeAz, type FakePr, type WorkItem } from '../azure/fake-az.ts';
import { observePr } from '../config/pr-host.ts';
import { observeIssue } from '../github/github.ts';
import type { TicketObservation } from './item-source.ts';
import { finishCompleted, observeRecords, type ObserveReads } from './observe-records.ts';

const REPO = 'maddec01/lar-factory';
const opened: { records: WorkRecords; dir: string }[] = [];
afterEach(() => {
  for (const { records, dir } of opened.splice(0)) {
    records.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
async function open(): Promise<WorkRecords> {
  const dir = mkdtempSync(join(tmpdir(), 'observe-records-'));
  const records = await openWorkRecords(join(dir, 'work-records.db'));
  opened.push({ records, dir });
  return records;
}

/** Provider reads that answer what `ticket` and `pr` hold now, or throw the error they hold. */
function provider(answers: { ticket?: TicketObservation | Error; pr?: PullRequestState | Error }) {
  const asked: string[] = [];
  const answer = <T>(value: T | Error | undefined, what: string): T => {
    if (value instanceof Error) throw value;
    if (value === undefined) throw new Error(`no ${what} answer`);
    return value;
  };
  return {
    answers, asked,
    reads: {
      ticket: async (repo: string, number: number) => (asked.push(`ticket ${repo}#${number}`), answer(answers.ticket, 'ticket')),
      pr: async (repo: string, number: number) => (asked.push(`pr ${repo}#${number}`), answer(answers.pr, 'PR')),
    },
  };
}

function build(records: WorkRecords, status: WorkRecord['status'] = 'Review', ticket: string | null = `${REPO}#12`): WorkRecord {
  const created = ticket ? records.importTicket({ title: 'Build', repository: REPO, kind: 'build', status, ticket }).record
    : records.create({ title: 'Build', repository: REPO, kind: 'build', status });
  return records.setPullRequest(created.workId, created.revision, `${REPO}#40`);
}

test('a merged PR finishes the build and makes it Done', async () => {
  const records = await open();
  const { workId } = build(records);
  const { reads } = provider({ pr: 'merged', ticket: { state: 'closed' } });
  await observeRecords(records, [REPO], reads);
  const record = records.read(workId);
  assert.equal(record.status, 'Done');
  assert.ok(record.finishedAt);
  assert.equal(record.needsYou, null, 'the ticket the merge closed flags nothing');
  assert.ok(records.completion(workId).complete);
});

test('a finished record keeps its ticket observed until retention hides it, and then takes no provider read', async () => {
  const records = await open();
  const { workId } = build(records);
  const { reads, asked } = provider({ pr: 'merged', ticket: { state: 'closed' } });
  await observeRecords(records, [REPO], reads);
  await observeRecords(records, [REPO], reads);
  assert.deepEqual(asked, [`pr ${REPO}#40`, `ticket ${REPO}#12`, `ticket ${REPO}#12`]);
  await observeRecords(records, [REPO], reads, new Set([workId]));
  assert.equal(asked.length, 3);
});

test('a PR closed unmerged sets Needs you once, leaving the Status as it was', async () => {
  const records = await open();
  const { workId } = build(records, 'Review', null);
  const { reads, asked } = provider({ pr: 'closed' });
  await observeRecords(records, [REPO], reads);
  const record = records.read(workId);
  assert.equal(record.status, 'Review');
  assert.equal(record.needsYou, `Its PR ${REPO}#40 closed without merging. Reopen it, start a replacement build from the same brief, or set the work aside.`);
  assert.deepEqual(asked, [`pr ${REPO}#40`], 'ticketless work reads only its PR');
  records.clearNeedsYou(workId, record.revision);
  await observeRecords(records, [REPO], reads);
  assert.equal(records.read(workId).needsYou, null, 'a PR that stays closed flags nothing again');
});

test('a ticket closing elsewhere sets Needs you without moving the Status', async () => {
  const records = await open();
  const { workId } = records.importTicket({ title: 'Bug', repository: REPO, kind: 'bug', status: 'Queued', ticket: `${REPO}#12` }).record;
  const { reads, answers } = provider({ ticket: { state: 'open' } });
  await observeRecords(records, [REPO], reads);
  assert.equal(records.read(workId).needsYou, null);
  answers.ticket = { state: 'closed' };
  await observeRecords(records, [REPO], reads);
  const record = records.read(workId);
  assert.deepEqual([record.status, record.setAside], ['Queued', false]);
  assert.equal(record.needsYou, `Its ticket ${REPO}#12 closed in its provider. Set the work aside, or clear this to keep working.`);
});

test('a ticket reopened after the work was Done sets Needs you', async () => {
  const records = await open();
  const { workId } = records.importTicket({ title: 'Bug', repository: REPO, kind: 'bug', status: 'Done', ticket: `${REPO}#12` }).record;
  const { reads, answers } = provider({ ticket: { state: 'closed' } });
  await observeRecords(records, [REPO], reads);
  assert.equal(records.read(workId).needsYou, null);
  answers.ticket = { state: 'open' };
  await observeRecords(records, [REPO], reads);
  const record = records.read(workId);
  assert.equal(record.status, 'Done');
  assert.equal(record.needsYou, `Its ticket ${REPO}#12 reopened after the work was Done. Reopen the work, or clear this.`);
});

test('a reassigned ticket sets Needs you without moving the Status', async () => {
  const records = await open();
  const { workId } = records.importTicket({ title: 'Bug', repository: REPO, kind: 'bug', status: 'In progress', ticket: `${REPO}#12` }).record;
  const { reads, answers } = provider({ ticket: { state: 'open', assignee: 'pedro' } });
  await observeRecords(records, [REPO], reads);
  answers.ticket = { state: 'open', assignee: 'ana' };
  await observeRecords(records, [REPO], reads);
  const record = records.read(workId);
  assert.equal(record.status, 'In progress');
  assert.equal(record.needsYou, `Its ticket ${REPO}#12 moved from pedro to ana. Check who owns the work, then clear this.`);
});

test('a confirmed not-found sets the work aside, and the record can be restored', async () => {
  const records = await open();
  const { workId } = records.importTicket({ title: 'Bug', repository: REPO, kind: 'bug', status: 'List', ticket: `${REPO}#12` }).record;
  await observeRecords(records, [REPO], provider({ ticket: { state: 'not-found' } }).reads);
  const record = records.read(workId);
  assert.equal(record.setAside, true);
  assert.equal(record.status, 'List');
  assert.match(record.needsYou!, /wasn't found in its provider, so the board set the work aside\. Restore it from Settings › Archive/);
  assert.equal(records.restore(workId, record.revision).setAside, false);
});

test('a temporary provider error keeps the last observation and changes nothing else', async () => {
  const records = await open();
  const { workId } = build(records);
  const { reads, answers } = provider({ pr: 'open', ticket: { state: 'open', assignee: 'pedro' } });
  await observeRecords(records, [REPO], reads);
  const before = records.read(workId);
  answers.pr = new Error('HTTP 502');
  answers.ticket = new Error('HTTP 502');
  await observeRecords(records, [REPO], reads);
  const after = records.read(workId);
  assert.deepEqual([after.status, after.needsYou, after.setAside, after.finishedAt], [before.status, before.needsYou, before.setAside, before.finishedAt]);
  assert.deepEqual(records.observations(workId).map((o) => [o.of, o.state, o.assignee, o.failure]),
    [['ticket', 'open', 'pedro', 'HTTP 502'], ['pr', 'open', null, 'HTTP 502']]);
});

test('set-aside work and work in repositories off the board read nothing', async () => {
  const records = await open();
  const aside = records.importTicket({ title: 'Bug', repository: REPO, kind: 'bug', ticket: `${REPO}#12` }).record;
  records.setAside(aside.workId, aside.revision);
  records.importTicket({ title: 'Other', repository: 'maddec01/other', kind: 'bug', ticket: 'maddec01/other#3' });
  const { reads, asked } = provider({ ticket: { state: 'closed' } });
  await observeRecords(records, [REPO], reads);
  assert.deepEqual(asked, []);
});

test('a decision whose answer and domain drafts are recorded, and a concept whose Fog is gone, become Done and finished', async () => {
  const records = await open();
  let decision = records.create({ title: 'Which store', repository: REPO, kind: 'decision', status: 'Shaping' });
  decision = records.setBody(decision.workId, decision.revision, 'answer', 'SQLite.');
  let concept = records.create({ title: 'Records', repository: REPO, kind: 'concept', status: 'Shaping' });
  finishCompleted(records, [REPO]);
  assert.deepEqual([records.read(decision.workId).status, records.read(concept.workId).status], ['Shaping', 'Shaping'], 'incomplete work keeps its Status');
  records.setBody(decision.workId, decision.revision, 'domain-drafts', 'None.');
  concept = records.setFogGone(concept.workId, concept.revision, true);
  finishCompleted(records, [REPO]);
  for (const { workId } of [decision, concept]) {
    const record = records.read(workId);
    assert.equal(record.status, 'Done');
    assert.ok(record.finishedAt);
  }
});

test('the provider reads at most six records at once', async () => {
  const records = await open();
  for (let n = 1; n <= 12; n++) records.importTicket({ title: `Bug ${n}`, repository: REPO, kind: 'bug', ticket: `${REPO}#${n}` });
  let running = 0;
  let most = 0;
  await observeRecords(records, [REPO], {
    ticket: async () => {
      most = Math.max(most, ++running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;
      return { state: 'open' };
    },
    pr: async () => 'open',
  });
  assert.equal(most, 6);
  assert.equal(records.list({}).filter((r) => records.observations(r.workId).length).length, 12, 'every record is observed');
});

test("a ticket the item source's last read shows open takes no read of its own", async () => {
  const records = await open();
  const { workId } = records.importTicket({ title: 'Bug', repository: REPO, kind: 'bug', ticket: `${REPO}#12` }).record;
  const { reads, asked } = provider({ ticket: new Error('not asked') });
  await observeRecords(records, [REPO], { ...reads, known: (repo, number) => (repo === REPO && number === 12 ? { state: 'open', assignee: 'pedro' } : undefined) });
  assert.deepEqual(asked, []);
  assert.deepEqual(records.observations(workId).map((o) => [o.of, o.state, o.assignee]), [['ticket', 'open', 'pedro']]);
});

/** A Dependency on `owner`'s ticket #5 and PR #9, held by a concept on the board with no ticket or PR of its own. */
function dependencyOn(records: WorkRecords, owner: string): string {
  const concept = records.create({ title: 'Concept', repository: REPO, kind: 'concept' });
  return records.addDependency(concept.workId, { need: 'A sign-in endpoint', owner, ticket: `${owner}#5`, pullRequests: [`${owner}#9`], handover: '# Handover' })
    .dependencyId;
}

/** What each of the Dependency's subjects was last read as, ticket first. */
const kinds = (records: WorkRecords, id: string) => records.dependency(id).observations.map((o) => o.kind);

/** A fake gh answering the Dependency's issue view and pr view from `answers`, each throwing to fail the call. */
function ghAnswering(answers: { ticket: () => string; pr: () => string }) {
  const calls: string[][] = [];
  const run = async (args: string[]) => (calls.push(args), args[0] === 'issue' ? answers.ticket() : answers.pr());
  const reads: ObserveReads = { ticket: (repo, number) => observeIssue(repo, number, run), pr: (repo, number) => observePr(repo, number, run) };
  return { calls, reads };
}
const issue = (state: string) => () => JSON.stringify({ state, assignees: [] });
const fails = (message: string) => () => { throw new Error(message); };

test("a Dependency's GitHub ticket and PR read as each kind, and the reads write nothing", async () => {
  const records = await open();
  const id = dependencyOn(records, 'acme/auth');
  const answers = { ticket: issue('OPEN'), pr: () => 'OPEN' };
  const gh = ghAnswering(answers);
  const observed = async (ticket: () => string, pr: () => string) => {
    Object.assign(answers, { ticket, pr });
    await observeRecords(records, [REPO], gh.reads);
    return kinds(records, id);
  };
  assert.deepEqual(await observed(issue('OPEN'), () => 'OPEN'), ['open', 'open']);
  assert.deepEqual(await observed(issue('CLOSED'), () => 'MERGED'), ['closed', 'merged']);
  assert.deepEqual(await observed(issue('OPEN'), () => 'CLOSED'), ['reopened', 'closed']);
  assert.deepEqual(await observed(issue('OPEN'), () => 'OPEN'), ['reopened', 'reopened'], 'it stays reopened while it stays open');
  assert.deepEqual(await observed(fails('GraphQL: Could not resolve to an issue or pull request with the number of 5.'),
    fails('GraphQL: Could not resolve to a PullRequest with the number of 9.')), ['deleted', 'deleted']);
  assert.deepEqual(await observed(fails('HTTP 403: Resource not accessible by personal access token'), fails('HTTP 401: Bad credentials')),
    ['access-lost', 'access-lost']);
  assert.deepEqual(await observed(fails('HTTP 502: Bad Gateway'), fails("GraphQL: Could not resolve to a Repository with the name 'acme/auth'.")),
    ['read-failed', 'read-failed'], "a repository GitHub doesn't resolve may be deleted or hidden, so it is a failed read");
  assert.deepEqual(records.dependency(id).observations.map((o) => [o.detail, o.lastGood?.kind]), [
    ['HTTP 502: Bad Gateway', 'deleted'], ["GraphQL: Could not resolve to a Repository with the name 'acme/auth'.", 'deleted'],
  ]);
  assert.deepEqual([...new Set(gh.calls.map((call) => call.slice(0, 2).join(' ')))], ['issue view', 'pr view'], 'only views, never an edit');
});

test("a Dependency's Azure work item and PR read as each kind, and the reads write nothing", async () => {
  const API = 'contoso/Fabrikam%20Fiber/Web%20Api';
  const records = await open();
  const id = dependencyOn(records, API);
  const item: WorkItem = { id: 5, type: 'User Story', state: 'Active' };
  const pr: FakePr = { pullRequestId: 9, status: 'active', sourceRefName: 'refs/heads/sign-in' };
  let failure: string | undefined;
  let az = fakeAz({ items: [item], pullRequests: [pr], fail: () => (failure ? new Error(failure) : undefined) });
  const calls: string[][] = [];
  const run = (args: string[]) => (calls.push(args), az.run(args));
  const source = azureBoard([API], 'Fabrikam Team', run);
  const reads: ObserveReads = { ticket: (repo, number) => source.observeTicket(repo, number), pr: (repo, number) => observePr(repo, number, run) };
  const observed = async (state: string, status: FakePr['status']) => {
    Object.assign(item, { state });
    Object.assign(pr, { status });
    await observeRecords(records, [REPO], reads);
    return kinds(records, id);
  };
  assert.deepEqual(await observed('Active', 'active'), ['open', 'open']);
  assert.deepEqual(await observed('Closed', 'completed'), ['closed', 'merged']);
  assert.deepEqual(await observed('Active', 'abandoned'), ['reopened', 'closed']);
  assert.deepEqual(await observed('Active', 'active'), ['reopened', 'reopened']);
  failure = "az devops invoke failed: TF400813: The user 'pedro@contoso.com' is not authorized to access this resource.";
  assert.deepEqual(await observed('Active', 'active'), ['access-lost', 'access-lost']);
  failure = 'az devops invoke failed: timed out';
  assert.deepEqual(await observed('Active', 'active'), ['read-failed', 'read-failed']);
  failure = undefined;
  az = fakeAz({ items: [] });
  assert.deepEqual(await observed('Active', 'active'), ['deleted', 'deleted'], 'a work item the batch omits and a PR az finds no more are deleted');
  const read = (call: string[]) => call.slice(0, 3).join(' ') === 'repos pr show'
    || (call.slice(0, 2).join(' ') === 'devops invoke' && (!call.includes('--http-method') || call[call.indexOf('--resource') + 1] === 'workitemsbatch'));
  assert.deepEqual(calls.filter((call) => !read(call)), [], 'only reads, never a write');
});

test('a read never changes the met mark: an outage leaves it unflagged, and a reopened ticket flags it for review', async () => {
  const records = await open();
  const id = dependencyOn(records, 'acme/auth');
  const answers = { ticket: issue('CLOSED'), pr: () => 'MERGED' };
  const { reads } = ghAnswering(answers);
  await observeRecords(records, [REPO], reads);
  records.markDependencyMet(id, records.dependency(id).revision, 'pedro');

  Object.assign(answers, { ticket: fails('HTTP 502: Bad Gateway'), pr: fails('HTTP 502: Bad Gateway') });
  await observeRecords(records, [REPO], reads);
  const outage = records.dependency(id);
  assert.deepEqual([outage.met?.by, outage.needsReview, outage.handover], ['pedro', false, '# Handover']);
  assert.deepEqual(outage.observations.map((o) => [o.kind, o.lastGood?.kind]), [['read-failed', 'closed'], ['read-failed', 'merged']]);

  Object.assign(answers, { ticket: issue('OPEN'), pr: () => 'MERGED' });
  await observeRecords(records, [REPO], reads);
  const reopened = records.dependency(id);
  assert.deepEqual([reopened.met?.by, reopened.needsReview, kinds(records, id)], ['pedro', true, ['reopened', 'merged']]);
});

test("each Dependency subject reads once a pass, and a ticket the item source's last read shows takes no read", async () => {
  const records = await open();
  const [first, second] = [dependencyOn(records, 'acme/auth'), dependencyOn(records, 'acme/auth')];
  const gh = ghAnswering({ ticket: issue('OPEN'), pr: () => 'MERGED' });
  await observeRecords(records, [REPO], gh.reads);
  assert.deepEqual(gh.calls.map((call) => call.slice(0, 2).join(' ')), ['issue view', 'pr view']);
  assert.deepEqual([kinds(records, first), kinds(records, second)], [['open', 'merged'], ['open', 'merged']]);

  const known = (repo: string, number: number) => (repo === 'acme/auth' && number === 5 ? { state: 'closed' as const } : undefined);
  await observeRecords(records, [REPO], { ...gh.reads, known });
  assert.deepEqual(gh.calls.slice(2).map((call) => call.slice(0, 2).join(' ')), ['pr view']);
  assert.deepEqual(kinds(records, first), ['closed', 'merged']);
});

test("a Dependency in a repository whose reads wait takes no read and keeps its last observation", async () => {
  const records = await open();
  const id = dependencyOn(records, 'acme/auth');
  const gh = ghAnswering({ ticket: issue('OPEN'), pr: () => 'OPEN' });
  await observeRecords(records, [REPO], gh.reads);
  const before = records.dependency(id);
  await observeRecords(records, [REPO], { ...gh.reads, waits: (repo) => repo === 'acme/auth' });
  assert.equal(gh.calls.length, 2);
  assert.deepEqual(records.dependency(id), before);
});
