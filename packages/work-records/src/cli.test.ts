import { execFile } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { openWorkRecords } from './work-records.ts';
import { afterEach, describe, expect, it } from 'vite-plus/test';

const CLI = join(import.meta.dirname, 'cli.ts');
const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'lar-work-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Runs lar-work from an empty folder, with HOME pointed at another, as a thread would with the board closed. */
async function larWork(dataDir: string, ...args: string[]) {
  const cwd = tempDir();
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, ...args, '--data-dir', dataDir], {
      cwd, env: { ...process.env, HOME: cwd },
    });
    return { code: 0, stdout, stderr, record: /^[[{]/.test(stdout) ? JSON.parse(stdout) : null };
  } catch (error) {
    const { code, stdout, stderr } = error as { code: number; stdout: string; stderr: string };
    return { code, stdout, stderr, record: null };
  }
}

// Each run starts a Node process, about a second apiece.
describe('lar-work', { timeout: 30_000 }, () => {
  it('creates, reads and updates a record in a data folder with no board running', async () => {
    const data = join(tempDir(), 'Lar Factory');
    const created = await larWork(data, 'create', '--title', 'Work', '--repository', 'maddec01/lar', '--kind', 'feature');
    expect(created).toMatchObject({ code: 0, record: { repository: 'maddec01/lar', status: 'List', revision: 1 } });
    const { workId } = created.record;

    const updated = await larWork(data, 'update', workId, '--revision', '1', '--status', 'Queued');
    expect(updated.record).toMatchObject({ workId, status: 'Queued', queueOrder: 1, revision: 2 });
    expect((await larWork(data, 'read', workId)).record).toEqual(updated.record);
    expect((await larWork(data, 'list', '--status', 'Queued')).record).toEqual([updated.record]);
    expect(readdirSync(data)).toContain('work-records.db');
  });

  it('imports a ticket once and attaches tickets without changing the work ID', async () => {
    const data = tempDir();
    const first = await larWork(data, 'import', '--title', 'Work', '--repository', 'maddec01/lar', '--kind', 'bug', '--ticket', 'maddec01/lar#5');
    const again = await larWork(data, 'import', '--title', 'Work', '--repository', 'maddec01/lar', '--kind', 'bug', '--ticket', 'maddec01/lar#5');
    expect(first.record.created).toBe(true);
    expect(again.record).toEqual({ record: first.record.record, created: false });

    const { workId } = (await larWork(data, 'create', '--title', 'Work', '--repository', 'maddec01/lar', '--kind', 'concept')).record;
    const linked = await larWork(data, 'attach-ticket', workId, '--revision', '1', '--ticket', 'maddec01/lar#6');
    expect(linked.record).toMatchObject({ workId, ticket: 'maddec01/lar#6' });
    expect((await larWork(data, 'set-aside', workId, '--revision', '2')).record).toMatchObject({ setAside: true });
    expect((await larWork(data, 'restore', workId, '--revision', '3')).record).toMatchObject({ setAside: false });
  });

  it('captures a title and initial context and prints the context as markdown', async () => {
    const data = tempDir();
    const context = join(tempDir(), 'context.md');
    writeFileSync(context, 'The board is too bright.\n');
    const { record } = await larWork(data, 'create', '--title', 'Add dark mode', '--repository', 'maddec01/lar', '--kind', 'feature', '--file', context);
    expect(record).toMatchObject({ title: 'Add dark mode' });
    expect(await larWork(data, 'context', record.workId)).toMatchObject({ code: 0, stdout: 'The board is too bright.\n' });
    expect(await larWork(data, 'create', '--repository', 'maddec01/lar', '--kind', 'feature')).toMatchObject({ code: 2, stderr: expect.stringContaining('--title is required') });
  });

  it('reports a stale revision on stderr and changes nothing', async () => {
    const data = tempDir();
    const { workId } = (await larWork(data, 'create', '--title', 'Work', '--repository', 'maddec01/lar', '--kind', 'bug')).record;
    await larWork(data, 'update', workId, '--revision', '1', '--status', 'Shaping');
    const stale = await larWork(data, 'update', workId, '--revision', '1', '--status', 'Ready');
    expect(stale).toMatchObject({ code: 1, stdout: '', stderr: `lar-work: The work record ${workId} is at revision 2, not 1; read it again and retry.\n` });
    expect((await larWork(data, 'read', workId)).record).toMatchObject({ status: 'Shaping', revision: 2 });
  });

  it('sets a parent and a blocker in a data folder with no board running', async () => {
    const data = tempDir();
    const create = async (kind: string) => (await larWork(data, 'create', '--title', 'Work', '--repository', 'maddec01/lar', '--kind', kind)).record.workId;
    const [build, slice, other] = [await create('build'), await create('slice'), await create('slice')];

    expect((await larWork(data, 'set-parent', slice, '--revision', '1', '--parent', build)).record).toMatchObject({ parentId: build, revision: 2 });
    expect((await larWork(data, 'add-blocker', slice, '--revision', '2', '--blocker', other)).record).toMatchObject({ revision: 3 });
    expect((await larWork(data, 'children', build)).record).toMatchObject([{ workId: slice }]);
    expect((await larWork(data, 'blockers', slice)).record).toMatchObject([{ workId: other }]);
    expect((await larWork(data, 'dependents', other)).record).toMatchObject([{ workId: slice }]);
    expect(await larWork(data, 'add-blocker', other, '--revision', '2', '--blocker', slice)).toMatchObject({ code: 1, stderr: expect.stringContaining('cycle') });
    expect((await larWork(data, 'remove-blocker', slice, '--revision', '3', '--blocker', other)).record).toMatchObject({ revision: 4 });
    expect((await larWork(data, 'clear-parent', slice, '--revision', '4')).record).toMatchObject({ parentId: null });
  });

  it('writes and reads a brief, a phase, a PR and a review round with no board running', async () => {
    const data = tempDir();
    const { workId } = (await larWork(data, 'create', '--title', 'Work', '--repository', 'maddec01/lar', '--kind', 'build')).record;
    const brief = join(tempDir(), 'brief.md');
    writeFileSync(brief, '## What\n\nAdd it.\n');
    expect((await larWork(data, 'set-body', workId, '--revision', '1', '--body', 'brief', '--file', brief)).record).toMatchObject({ revision: 2 });
    expect(await larWork(data, 'body', workId, '--body', 'brief')).toMatchObject({ code: 0, stdout: '## What\n\nAdd it.\n' });
    expect(await larWork(data, 'body', workId, '--body', 'map')).toMatchObject({ code: 1, stderr: `lar-work: The work record ${workId} has no map.\n` });

    expect((await larWork(data, 'set-phase', workId, '--revision', '2', '--phase', 'review')).record).toMatchObject({ buildPhase: 'review' });
    expect((await larWork(data, 'set-pr', workId, '--revision', '3', '--pr', 'maddec01/lar#8')).record).toMatchObject({ pullRequest: 'maddec01/lar#8' });
    expect((await larWork(data, 'set-pr', workId, '--revision', '4', '--pr', 'maddec01/lar#9')).record).toMatchObject({ pullRequest: 'maddec01/lar#9' });
    expect((await larWork(data, 'pr-history', workId)).record).toMatchObject([{ pullRequest: 'maddec01/lar#8' }]);
    const round = join(tempDir(), 'round.json');
    writeFileSync(round, JSON.stringify({ base: 'c8890a1a', reviewers: [{ axis: 'code', verdict: 'changes', findings: [{ severity: 'should', summary: 'Spec: a.ts:1: x.', disposition: 'open' }] }] }));
    expect((await larWork(data, 'record-review-round', workId, '--revision', '5', '--file', round)).record).toMatchObject({ revision: 6 });
    await larWork(data, 'set-disposition', workId, '--revision', '6', '--round', '1', '--axis', 'code', '--finding', '1', '--disposition', 'rejected', '--reason', 'Out of scope.');
    expect((await larWork(data, 'review-rounds', workId)).record).toMatchObject([{ round: 1, reviewers: [{ axis: 'code', findings: [{ disposition: 'rejected', reason: 'Out of scope.' }] }] }]);
  });

  it('records a launch intent and resolves it to a thread with no board running', async () => {
    const data = tempDir();
    const { workId } = (await larWork(data, 'create', '--title', 'Work', '--repository', 'maddec01/lar', '--kind', 'feature')).record;
    const { intent } = (await larWork(data, 'record-intent', workId, '--revision', '1', '--purpose', 'shape')).record;
    expect((await larWork(data, 'intents', '--unresolved')).record).toEqual([intent]);

    const resolved = await larWork(data, 'resolve-intent', workId, '--revision', '2', '--intent', intent.intentId, '--thread', 'thread-1');
    expect(resolved.record).toMatchObject({ record: { revision: 3 }, intent: { outcome: 'started', threadId: 'thread-1' } });
    expect((await larWork(data, 'intents', '--unresolved')).record).toEqual([]);
    expect((await larWork(data, 'threads', workId)).record).toMatchObject([{ threadId: 'thread-1', purpose: 'shape' }]);
    expect(await larWork(data, 'resolve-intent', workId, '--revision', '3', '--intent', intent.intentId, '--failure', 'x')).toMatchObject({ code: 1, stderr: expect.stringContaining('already resolved') });
    expect(await larWork(data, 'resolve-intent', workId, '--revision', '3', '--intent', intent.intentId)).toMatchObject({ code: 2, stderr: expect.stringContaining('--thread or --failure') });
  });

  it('sets and clears a Needs you reason and snapshots skills with no board running', async () => {
    const data = tempDir();
    const { workId } = (await larWork(data, 'create', '--title', 'Work', '--repository', 'maddec01/lar', '--kind', 'build')).record;
    expect((await larWork(data, 'set-needs-you', workId, '--revision', '1', '--reason', 'Its PR closed without merging.')).record).toMatchObject({ needsYou: 'Its PR closed without merging.' });
    expect((await larWork(data, 'clear-needs-you', workId, '--revision', '2')).record).toMatchObject({ needsYou: null, revision: 3 });
    expect((await larWork(data, 'snapshot-skills', workId, '--revision', '3', '--skill', 'react-patterns', '--skill', 'acme:testing')).record).toMatchObject({ skills: ['react-patterns', 'acme:testing'] });
    expect(await larWork(data, 'snapshot-skills', workId, '--revision', '4')).toMatchObject({ code: 1, stderr: expect.stringContaining('already snapshotted') });
  });

  it('reports completion and the blockers a record waits on with no board running', async () => {
    const data = tempDir();
    const create = async (kind: string) => (await larWork(data, 'create', '--title', 'Work', '--repository', 'maddec01/lar', '--kind', kind)).record.workId;
    const [concept, slice, build] = [await create('concept'), await create('slice'), await create('build')];
    await larWork(data, 'add-blocker', build, '--revision', '1', '--blocker', slice);
    expect((await larWork(data, 'waiting-on', build)).record).toEqual([{ workId: slice, reasons: ["It isn't finished."] }]);
    expect((await larWork(data, 'finish', slice, '--revision', '2')).record).toMatchObject({ finishedAt: expect.any(String) });
    expect((await larWork(data, 'waiting-on', build)).record).toEqual([]);
    expect(await larWork(data, 'finish', build, '--revision', '2')).toMatchObject({ code: 1, stderr: expect.stringContaining('Only a slice') });

    expect((await larWork(data, 'set-fog', concept, '--revision', '1', '--fog', 'gone')).record).toMatchObject({ fogGone: true });
    expect((await larWork(data, 'completion', concept)).record).toEqual({ complete: true, reasons: [] });
    expect((await larWork(data, 'set-fog', concept, '--revision', '2', '--fog', 'remaining')).record).toMatchObject({ fogGone: false });
    expect((await larWork(data, 'completion', concept)).record).toEqual({ complete: false, reasons: ["Its Fog isn't gone."] });
    expect(await larWork(data, 'set-fog', concept, '--revision', '3', '--fog', 'thin')).toMatchObject({ code: 2, stderr: expect.stringContaining('--fog takes gone or remaining') });
  });

  it("records a ticket's observations and a failed read with no board running", async () => {
    const data = tempDir();
    const { workId } = (await larWork(data, 'create', '--title', 'Work', '--repository', 'maddec01/lar', '--kind', 'bug', '--ticket', 'maddec01/lar#4')).record;
    expect((await larWork(data, 'observe', workId, '--revision', '1', '--of', 'ticket', '--state', 'open', '--assignee', 'pedro')).record).toMatchObject({ revision: 2 });
    expect((await larWork(data, 'observe-failure', workId, '--revision', '2', '--of', 'ticket', '--failure', 'GitHub answered 502.')).record).toMatchObject({ revision: 3 });
    expect((await larWork(data, 'observations', workId)).record).toMatchObject([{ of: 'ticket', state: 'open', assignee: 'pedro', failure: 'GitHub answered 502.' }]);
    expect(await larWork(data, 'observe', workId, '--revision', '2', '--of', 'ticket', '--state', 'closed')).toMatchObject({ code: 1, stderr: expect.stringContaining('revision 3, not 2') });
    expect((await larWork(data, 'observations', workId)).record).toMatchObject([{ state: 'open' }]);
  });

  it("saves this machine's retention setting and hides and deletes set-aside records with it", async () => {
    const data = tempDir();
    expect((await larWork(data, 'retention')).record).toEqual({ hideAfterDays: 7, deleteAfterDays: null });
    const { workId } = (await larWork(data, 'create', '--title', 'Work', '--repository', 'maddec01/lar', '--kind', 'feature')).record;
    const kept = (await larWork(data, 'create', '--title', 'Work', '--repository', 'maddec01/lar', '--kind', 'bug')).record;
    await larWork(data, 'set-aside', workId, '--revision', '1');
    expect((await larWork(data, 'hidden')).record).toEqual([]);

    expect((await larWork(data, 'retention', '--hide-after', '0')).record).toEqual({ hideAfterDays: 0, deleteAfterDays: null });
    expect((await larWork(data, 'hidden')).record).toMatchObject([{ workId }]);
    expect((await larWork(data, 'delete-expired')).record).toEqual({ deleted: [], kept: [] });
    expect((await larWork(data, 'retention', '--delete-after', '0')).record).toEqual({ hideAfterDays: 0, deleteAfterDays: 0 });
    expect((await larWork(data, 'delete-expired')).record).toEqual({ deleted: [workId], kept: [] });
    expect((await larWork(data, 'list')).record).toEqual([kept]);
    expect((await larWork(data, 'retention', '--delete-after', 'never')).record).toEqual({ hideAfterDays: 0, deleteAfterDays: null });
    expect(await larWork(data, 'retention', '--delete-after', 'soon')).toMatchObject({ code: 2, stderr: expect.stringContaining('whole number of days or never') });
  });

  it('exports a brief as markdown to a folder and refuses a missing folder', async () => {
    const data = tempDir();
    const { workId } = (await larWork(data, 'create', '--title', 'Work', '--repository', 'maddec01/lar', '--kind', 'build')).record;
    const brief = join(tempDir(), 'brief.md');
    writeFileSync(brief, '# Add it\n');
    await larWork(data, 'set-body', workId, '--revision', '1', '--body', 'brief', '--file', brief);
    const to = tempDir();
    expect((await larWork(data, 'export', workId, '--to', to)).record).toEqual([join(to, 'brief-add-it.md')]);
    expect(readdirSync(to)).toEqual(['brief-add-it.md']);
    expect(await larWork(data, 'export', workId, '--to', join(to, 'missing'))).toMatchObject({ code: 1, stderr: expect.stringContaining("isn't a folder") });
  });

  it('records a Dependency that holds a build until it is marked met, then replaces it with a build', async () => {
    const data = tempDir();
    const create = async (kind: string) => (await larWork(data, 'create', '--title', 'Work', '--repository', 'maddec01/lar', '--kind', kind)).record;
    const [build, replacement] = [await create('build'), await create('build')];
    const file = join(tempDir(), 'dependency.json');
    writeFileSync(file, JSON.stringify({ need: 'A sign-in endpoint.', owner: 'acme/auth', pullRequests: ['acme/auth#9'], handover: 'Please add it.' }));
    const { dependencyId } = (await larWork(data, 'add-dependency', build.workId, '--file', file)).record;
    expect((await larWork(data, 'add-dependency-block', dependencyId, '--revision', '1', '--build', build.workId)).record).toMatchObject({ blocks: [build.workId] });
    expect((await larWork(data, 'waiting-on', build.workId)).record).toEqual([{ dependencyId, reasons: ["It isn't marked met."] }]);
    expect((await larWork(data, 'blockers', build.workId)).record).toMatchObject([{ dependencyId }]);

    expect((await larWork(data, 'observe-dependency', dependencyId, '--revision', '2', '--subject', 'acme/auth#9', '--state', 'merged')).record).toMatchObject({ met: null });
    expect((await larWork(data, 'waiting-on', build.workId)).record).toHaveLength(1);
    expect((await larWork(data, 'mark-met', dependencyId, '--revision', '3', '--identity', 'pedro')).record).toMatchObject({ met: { by: 'pedro' } });
    expect((await larWork(data, 'waiting-on', build.workId)).stdout).toBe('[]\n');
    expect((await larWork(data, 'clear-met', dependencyId, '--revision', '4')).record).toMatchObject({ met: null });
    writeFileSync(file, JSON.stringify({ contract: 'POST /sign-in.' }));
    expect((await larWork(data, 'update-dependency', dependencyId, '--revision', '5', '--file', file)).record).toMatchObject({ contract: 'POST /sign-in.', revision: 6 });

    expect((await larWork(data, 'replace-dependency', dependencyId, '--revision', '6', '--build', replacement.workId)).record).toMatchObject({ blocks: [], replacedBy: replacement.workId });
    expect((await larWork(data, 'blockers', build.workId)).record).toMatchObject([{ workId: replacement.workId }]);
    expect((await larWork(data, 'dependencies', build.workId)).record).toMatchObject([{ dependencyId, handover: 'Please add it.' }]);
    expect(await larWork(data, 'dependency')).toMatchObject({ code: 2, stderr: expect.stringContaining('needs a Dependency ID') });
  });

  it('reports usage mistakes before opening the database', async () => {
    const data = join(tempDir(), 'unused');
    expect(await larWork(data, 'frobnicate')).toMatchObject({ code: 2, stderr: expect.stringContaining('Unknown command "frobnicate"') });
    expect(await larWork(data, 'read')).toMatchObject({ code: 2, stderr: expect.stringContaining('read needs a work ID') });
    expect(readdirSync(join(data, '..'))).toEqual([]);
  });

  it('explains identifiers, reads, changes, structure and errors in its help', async () => {
    const help = await larWork(tempDir(), '--help');
    expect(help.code).toBe(0);
    for (const heading of ['Identifiers', 'Reads', 'Changes', 'Structure', 'Completion', 'Content', 'Publication', 'Provider observations', 'Dependencies', 'Threads and launch intents', 'Retention and export', 'Errors']) expect(help.stdout).toContain(`\n${heading}\n`);
  });
});


it('inspects, approves, claims, reconciles and attaches a publication through lar-work', { timeout: 30_000 }, async () => {
  const data = tempDir();
  const records = await openWorkRecords(join(data, 'work-records.db'));
  const made = records.create({ title: 'Search', repository: 'team/app', kind: 'build' });
  const work = records.setBody(made.workId, made.revision, 'brief', 'Find saved searches.');
  records.close();
  const gate = await larWork(data, 'gate', work.workId);
  expect(gate.record).toMatchObject({ current: false, briefDigest: expect.any(String) });
  expect(await larWork(data, 'record-gate', work.workId, '--revision', String(work.revision), '--digest', gate.record.briefDigest, '--identity', 'reviewer', '--evidence', 'Passed.')).toMatchObject({ code: 0 });
  expect((await larWork(data, 'gate', work.workId)).record.current).toBe(true);
  const readiness = (await larWork(data, 'publication-readiness', work.workId)).record;
  expect(readiness.eligible).toBe(true);
  const content = {
    tickets: [{ workId: work.workId, destination: { provider: 'github', repository: 'team/app' }, vocabulary: {}, typeResolution: { candidates: [], selected: null }, title: 'Search', body: 'Find saved searches.' }],
    operations: [{ kind: 'create', operationId: 'create', ticketWorkId: work.workId, dependsOn: [] },
      { kind: 'comment', operationId: 'comment', ticketWorkId: work.workId, dependsOn: ['create'], content: 'Search is ready.' }],
  };
  const file = join(tempDir(), 'request.json');
  writeFileSync(file, JSON.stringify({ ...content, sources: readiness.sources.map(({ workId, revision }: { workId: string; revision: number }) => ({ workId, revision })) }));
  const proposed = (await larWork(data, 'propose-publication', work.workId, '--revision', String(work.revision), '--file', file)).record;
  expect(proposed).toMatchObject({ revision: 1, approval: null });
  const planArgs = [work.workId, '--plan', proposed.planId];
  expect((await larWork(data, 'publication', ...planArgs)).record).toEqual(proposed);
  expect((await larWork(data, 'publications', work.workId)).record).toEqual([proposed]);
  expect(await larWork(data, 'approve-publication', ...planArgs, '--revision', '1', '--digest', 'wrong', '--identity', 'pedro')).toMatchObject({ code: 1 });
  expect((await larWork(data, 'approve-publication', ...planArgs, '--revision', '1', '--digest', proposed.digest, '--identity', 'pedro')).record).toMatchObject({ revision: 2, approval: { approvedBy: 'pedro' } });
  writeFileSync(file, JSON.stringify(content));
  expect((await larWork(data, 'pending-publication', ...planArgs, '--file', file)).record).toMatchObject({ current: true, next: { operationId: 'create' } });
  const claimed = (await larWork(data, 'claim-publication', ...planArgs, '--revision', '2', '--digest', proposed.digest, '--identity', 'board', '--file', file)).record;
  expect(claimed).toMatchObject({ plan: { revision: 3 }, operation: { kind: 'create' }, claimToken: expect.any(String) });
  writeFileSync(file, JSON.stringify({ status: 'uncertain', evidence: 'Timed out after dispatch.' }));
  expect((await larWork(data, 'record-publication-outcome', ...planArgs, '--revision', '3', '--operation', 'create', '--claim', claimed.claimToken, '--file', file)).record).toMatchObject({ revision: 4 });
  expect((await larWork(data, 'record-publication-evidence', ...planArgs, '--revision', '4', '--operation', 'create', '--evidence', 'Searched the fixture provider.')).record).toMatchObject({ revision: 5 });
  writeFileSync(file, JSON.stringify({ status: 'successful', evidence: 'Found the created ticket.', ticket: 'team/app#12', url: 'https://example.test/issues/12', location: { kind: 'body', start: 0, end: 20 } }));
  expect((await larWork(data, 'resolve-publication-outcome', ...planArgs, '--revision', '5', '--operation', 'create', '--identity', 'pedro', '--file', file)).record).toMatchObject({ revision: 6 });
  expect((await larWork(data, 'publication-evidence', ...planArgs)).record).toHaveLength(4);
  expect((await larWork(data, 'last-published', work.workId)).record).toMatchObject([{ text: 'Find saved searches.', location: { kind: 'body', start: 0, end: 20 } }]);
  expect((await larWork(data, 'publication-handover', ...planArgs)).stdout).toBe('# Search\n\nFind saved searches.\n\nSearch is ready.\n');
  expect((await larWork(data, 'attach-publication-url', ...planArgs, '--revision', String(work.revision), '--ticket', 'team/app#12', '--url', 'https://example.test/issues/12')).record).toMatchObject({ workId: work.workId, ticket: 'team/app#12', status: 'List' });
  expect((await larWork(data, 'publication-attachment', work.workId)).record).toMatchObject({ planId: proposed.planId, ticket: 'team/app#12', url: 'https://example.test/issues/12' });
  expect((await larWork(data, 'pending-publication', ...planArgs)).record).toMatchObject({ current: true, next: { operationId: 'comment' } });
  writeFileSync(file, 'not JSON');
  expect(await larWork(data, 'record-publication-outcome', ...planArgs, '--revision', '6', '--operation', 'comment', '--claim', 'no-claim', '--file', file)).toMatchObject({ code: 1, stderr: expect.stringContaining("isn't JSON") });
});
