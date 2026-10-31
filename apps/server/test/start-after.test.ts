import { test } from 'vite-plus/test';
import type { TestContext } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { NOT_LANDED, SAMPLE_MODELS, changeRecords, recordBlockers, settleDecisions, startableEnv, startBoard, until, writeOnboarding } from './server-support.ts';
import type { Board } from './server-support.ts';
import { openWorkRecords, workRecordsPath } from '@lar-factory/work-records';
import { rawIssue } from '@lar-factory/shared/test/raw-items';
import type { BoardData, RawItem } from '@lar-factory/shared';

const OPUS = { instanceId: 'claudeAgent_personal', model: 'claude-opus-5-5' };

const build = rawIssue('I_12', 12, 'Ready', ['build']);

/** A board that can start lar-factory threads, offering the sample model choices, and its environment. */
async function armableBoard(t: TestContext, items: RawItem[], options: object = {}, env: Record<string, string> = { ...startableEnv(t), ...SAMPLE_MODELS }) {
  const board = await startBoard(t, { items, ...options }, false, false, env);
  await until(board, (d) => d.items.length === items.length);
  return { board, env };
}

/** A board whose build #12 waits on two decisions, the first settled; returns the open one's work ID too. */
async function blockedBuildBoard(t: TestContext, options: object = {}) {
  const armable = await armableBoard(t, [build], options);
  const [settled, open] = await recordBlockers(armable.board, armable.board.id(12), ['Decision 5', 'Decision 6']);
  await settleDecisions(armable.board, armable.board.id(12), [settled!]);
  return { ...armable, open: open! };
}

const arm = (board: Board, itemId: string, model?: unknown) => board.postSession({ itemId, model }, '/api/arm');
const disarm = (board: Board, itemId: string) => board.postSession({ itemId }, '/api/disarm');
const armedPath = (home: string) => join(home, 'Library/Application Support/Lar Factory/armed-starts.json');
const armedFile = (home: string) => JSON.parse(readFileSync(armedPath(home), 'utf8'));

/** Asks for a read and waits until it lands. */
async function read(board: Board): Promise<BoardData> {
  const before = (await board.board() as BoardData).fetchedAt;
  await board.post({}, board.url, '/api/read');
  return until(board, (d) => d.fetchedAt !== before);
}

test('arming and disarming write and remove the entry, which the board data carries', async (t) => {
  const { board, env } = await blockedBuildBoard(t);
  const armed = await arm(board, board.id(12), OPUS);
  assert.equal(armed.status, 200);
  assert.deepEqual((await armed.json()).board.armed, { [board.id(12)]: { model: OPUS } });
  assert.deepEqual(armedFile(env.HOME!), { [board.id(12)]: { model: OPUS } });
  const disarmed = await disarm(board, board.id(12));
  assert.equal(disarmed.status, 200);
  assert.deepEqual((await disarmed.json()).board.armed, {});
  assert.deepEqual(armedFile(env.HOME!), {});
});

test('armed starts survive a board restart', async (t) => {
  const { board, env } = await blockedBuildBoard(t);
  assert.equal((await arm(board, board.id(12))).status, 200);
  await board.stop();
  const { board: again } = await armableBoard(t, [build], {}, env);
  assert.deepEqual((await again.board() as BoardData).armed, { [board.id(12)]: {} });
});

test('a refresh with a blocker incomplete starts nothing; once the last completes, the board starts the build once, on its armed model', async (t) => {
  const { board, env, open } = await blockedBuildBoard(t);
  assert.equal((await arm(board, board.id(12), OPUS)).status, 200);
  // A start disarms its part before the read's data is served, so a part still armed didn't start.
  assert.deepEqual((await read(board)).armed, { [board.id(12)]: { model: OPUS } });
  // No ticket read is asked for: the board sees the decision complete in the work records.
  await settleDecisions(board, board.id(12), [open]);
  const started = await until(board, (d) => !!d.startedBuilds?.[board.id(12)]);
  assert.deepEqual(started.armed, {});
  assert.deepEqual(armedFile(env.HOME!), {});
  await read(board);
  assert.deepEqual((await board.t3Calls()).map((args) => args.slice(0, 3).concat(args.slice(4, 8))), [
    ['thread', 'start', 'project-factory', '--provider', 'claudeAgent_personal', '--model', 'claude-opus-5-5'],
  ]);
  assert.ok((await board.t3Calls())[0]!.includes('--worktree'), 'a build starts in its own worktree');
});

/** Records a Dependency on the server team holding the board's build #12, its ticket read as closed; returns its ID. */
async function recordClosedDependency(board: Board): Promise<string> {
  let dependencyId = '';
  await changeRecords(board, (records) => {
    let dependency = records.addDependency(board.id(12), { need: 'An export endpoint', owner: 'server team', ticket: 'maddec01/lar-server#40' });
    dependency = records.addDependencyBlock(dependency.dependencyId, dependency.revision, board.id(12));
    dependency = records.observeDependency(dependency.dependencyId, dependency.revision, { subject: 'maddec01/lar-server#40', kind: 'closed' });
    dependencyId = dependency.dependencyId;
  }, board.id(12), (item) => item.blockers.some((b) => b.dependency?.observation?.kind === 'closed'));
  return dependencyId;
}

const markMet = async (board: Board, dependencyId: string, met: boolean) => {
  const hold = (await board.board() as BoardData).items.flatMap((i) => i.blockers).find((b) => b.dependency?.dependencyId === dependencyId)!.dependency!;
  return board.postSession({ itemId: board.id(12), dependencyId, revision: hold.revision, met }, '/api/dependency-met');
};

test('a Dependency whose ticket closed still holds Start and Start after until the user marks it met, which fires the armed start', async (t) => {
  const { board } = await armableBoard(t, [build]);
  const dependencyId = await recordClosedDependency(board);
  const refused = await board.postSession({ itemId: board.id(12) }, '/api/start-build');
  assert.equal(refused.status, 409);
  assert.match((await refused.json()).error, /^Blocked by the Dependency on server team until you mark it met/);
  assert.equal((await arm(board, board.id(12), OPUS)).status, 200);
  assert.deepEqual((await read(board)).armed, { [board.id(12)]: { model: OPUS } }, 'the closed ticket alone starts nothing');
  const marked = await markMet(board, dependencyId, true);
  assert.equal(marked.status, 200);
  const started = await until(board, (d) => !!d.startedBuilds?.[board.id(12)]);
  assert.deepEqual(started.armed, {});
});

test('clearing the met mark holds the build again', async (t) => {
  const { board } = await armableBoard(t, [build]);
  const dependencyId = await recordClosedDependency(board);
  assert.equal((await markMet(board, dependencyId, true)).status, 200);
  const cleared = await markMet(board, dependencyId, false);
  assert.equal(cleared.status, 200);
  const item = (await cleared.json()).board.items.find((i: { id: string }) => i.id === board.id(12));
  assert.deepEqual(item.blockers.map((b: { state: string; dependency: { met: unknown } }) => [b.state, b.dependency.met]), [['open', null]]);
  assert.equal((await markMet(board, dependencyId, false)).status, 409, 'a stale revision is refused');
});

test("a Queued decision starts with today's Start once its blockers complete", async (t) => {
  const { board } = await armableBoard(t, [rawIssue('I_20', 20, 'Queued', ['decision-grill'])]);
  const blockers = await recordBlockers(board, board.id(20), ['Decision 5', 'Decision 6']);
  assert.equal((await arm(board, board.id(20))).status, 200);
  await settleDecisions(board, board.id(20), blockers);
  await until(board, (d) => !!d.started?.[board.id(20)]);
  assert.deepEqual(await board.t3Calls(), [['thread', 'start', 'project-factory', `#20 Issue 20\n$lar-shape ${board.id(20)}`, '--json']]);
});

test('a failed start disarms the part and shows its error on it, until it is armed again', async (t) => {
  const { board, env, open } = await blockedBuildBoard(t, { t3: { fail: 'down' } });
  assert.equal((await arm(board, board.id(12))).status, 200);
  await settleDecisions(board, board.id(12), [open]);
  const failed = await until(board, (d) => !!d.armedErrors?.[board.id(12)]);
  assert.deepEqual(failed.armed, {});
  assert.deepEqual(armedFile(env.HOME!), {});
  await recordBlockers(board, board.id(12), ['Decision 7']);
  const rearmed = await arm(board, board.id(12));
  assert.equal(rearmed.status, 200);
  assert.equal((await rearmed.json()).board.armedErrors[board.id(12)], undefined);
});

test("a part whose repository has no T3 project can't be armed, as its start would fail", async (t) => {
  const server = rawIssue('I_30', 30, 'Ready', ['build'], {
    url: 'https://github.com/maddec01/lar-server/issues/30', repository: { nameWithOwner: 'maddec01/lar-server' },
  });
  const { board } = await armableBoard(t, [server]);
  await recordBlockers(board, board.id(30, 'maddec01/lar-server'), ['Decision 5']);
  await until(board, (d) => !!d.repositoryProjects);
  const refused = await arm(board, board.id(30, 'maddec01/lar-server'));
  assert.equal(refused.status, 409);
  const answer = await refused.json();
  assert.equal(answer.error, 'No T3 project is a checkout of maddec01/lar-server; add the checkout in T3 Code');
  assert.deepEqual(answer.board.armed, {});
});


test('an armed start whose repository leaves the board drops on the next read and never starts, also after a restart', async (t) => {
  const { board, env, open } = await blockedBuildBoard(t, { files: ['.lar-factory.json'] });
  assert.equal((await arm(board, board.id(12), OPUS)).status, 200);
  const list = join(env.HOME!, 'Library/Application Support/Lar Factory/repository-settings.json');
  const { repositories, ...rest } = JSON.parse(readFileSync(list, 'utf8')) as { repositories: { repo: string }[] };
  writeFileSync(list, JSON.stringify({ ...rest, repositories: repositories.filter((r) => r.repo !== 'maddec01/lar-factory') }));
  const records = await openWorkRecords(workRecordsPath(board.dataDir));
  try {
    records.setBody(open, records.read(open).revision, 'answer', 'Settled.');
    records.setBody(open, records.read(open).revision, 'domain-drafts', 'None.');
  } finally { records.close(); }
  await read(board);
  const data = await until(board, (d) => d.items.length === 0 && Object.keys(d.armed ?? {}).length === 0);
  assert.deepEqual([data.items, data.armed], [[], {}]);
  assert.deepEqual(armedFile(env.HOME!), {});
  await board.stop();
  const again = await startBoard(t, { items: [build] }, false, false, env);
  assert.deepEqual((await read(again)).items, []);
  assert.deepEqual([await board.t3Calls(), await again.t3Calls()], [[], []]);
});

test('only a blocked Ready or Queued issue, on an offered model, from this page and session, can be armed', async (t) => {
  const { board } = await armableBoard(t, [build, rawIssue('I_13', 13, 'Ready', []), rawIssue('I_14', 14, 'In progress', [])]);
  await recordBlockers(board, board.id(12), ['Decision 5']);
  await recordBlockers(board, board.id(14), ['Decision 6']);
  assert.match((await (await arm(board, board.id(13))).json()).error, /^Nothing blocks this item now/);
  assert.match((await (await arm(board, board.id(14))).json()).error, /^Only Ready and Queued items can start after their blockers; this one is in In progress\.$/);
  assert.equal((await arm(board, 'I_missing')).status, 404);
  assert.equal((await arm(board, board.id(12), { instanceId: 'codex', model: '--help' })).status, 422);
  const restarted = await board.post({ session: 'old', itemId: board.id(12) }, board.url, '/api/arm');
  assert.equal(restarted.status, 409);
  assert.match((await restarted.json()).error, /Press Start after again/);
  assert.equal((await board.post({ itemId: board.id(12) }, 'https://evil.example', '/api/disarm')).status, 403);
  assert.equal((await board.board() as BoardData).armed?.[board.id(12)], undefined);
  const sample = await startBoard(t, {}, true);
  assert.equal((await arm(sample, 'I_sample13')).status, 403);
  assert.equal((await disarm(sample, 'I_sample13')).status, 403);
});
