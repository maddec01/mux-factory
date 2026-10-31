import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import type { Item } from '@lar-factory/shared';
import { openWorkRecords, type WorkRecords } from '@lar-factory/work-records';
import { exportMarkdown } from '@lar-factory/work-records/export';
import { createItemDetails } from './item-details.ts';

const opened: string[] = [];
afterEach(() => {
  for (const dir of opened.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Work records in a fresh folder, as lar-work writes them, and an empty export folder beside them. */
async function recordsOn(): Promise<{ records: WorkRecords; dir: string; exportFolder: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'item-details-'));
  opened.push(dir);
  const records = await openWorkRecords(join(dir, 'work-records.db'));
  const exportFolder = join(dir, 'Downloads');
  mkdirSync(exportFolder);
  return { records, dir, exportFolder };
}

const WEB = 'maddec01/lar-web';
/** The board item a record shows as: its work ID, and no ticket. */
const boardItem = (workId: string) => ({ id: workId, content: 'ticket', revision: 0, kind: 'build', parentId: null, repo: WEB, number: 0 }) as Item;

const workItem = { id: 'azure:contoso/5', content: 'ticket', revision: 0, kind: 'issue', parentId: null, repo: 'contoso/Fabrikam%20Fiber/lar-api', number: 5 } as Item;

test('an Azure DevOps save without the field and revision its details gave is refused before az runs', async () => {
  const { saveDescription } = createItemDetails(null, (item) => item);
  const refused = { status: 400, error: 'Send the field and revision the work item\'s details gave.' };
  assert.deepEqual(await saveDescription(workItem, { body: 'x' }), refused);
  assert.deepEqual(await saveDescription(workItem, { body: 'x', bodyField: 'System.Description' }), refused);
  assert.deepEqual(await saveDescription(workItem, { body: 'x', revision: 3 }), refused);
});

test('sample mode saves no description', async () => {
  assert.deepEqual(await createItemDetails('unused.json', (item) => item).saveDescription(workItem, { body: 'x' }), { status: 403, error: 'Saving descriptions is disabled in sample mode.' });
});

test('work with no ticket has no details and saves no description', async () => {
  const { details, saveDescription } = createItemDetails(null, () => undefined);
  assert.equal((await details(workItem) as { body: string }).body, '');
  assert.deepEqual(await saveDescription(workItem, { body: 'x' }), { status: 409, error: 'This work has no ticket the board has read.' });
});

test("a build's details hold its brief, initial context, build phase and review rounds from its record", async () => {
  const { records, exportFolder } = await recordsOn();
  let build = records.create({ title: 'Owner accounts', context: 'Owners sign up.', repository: WEB, kind: 'build' });
  build = records.setBody(build.workId, build.revision, 'brief', '# Owner accounts\n\nAdd an owner table.');
  build = records.setBuildPhase(build.workId, build.revision, 'review');
  records.recordReviewRound(build.workId, build.revision, { base: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', reviewers: [
    { axis: 'code', verdict: 'changes', findings: [{ severity: 'should', summary: 'Name the table.', disposition: 'open' }, { severity: 'nit', summary: 'Typo.', disposition: 'fixed' }] },
    { axis: 'security', verdict: 'approve', findings: [] },
  ] });
  const read = await createItemDetails(null, () => undefined, { records, exportFolder }).details(boardItem(build.workId));
  const { recordedAt, ...round } = (read as { record: { reviewRounds: { recordedAt: string }[] } }).record.reviewRounds[0]!;
  assert.match(recordedAt, /^\d{4}-/);
  assert.deepEqual({ ...(read as { record: object }).record, reviewRounds: [round] }, {
    bodyKind: 'brief', body: '# Owner accounts\n\nAdd an owner table.', context: 'Owners sign up.', buildPhase: 'review',
    reviewRounds: [{ round: 1, reviewers: [{ axis: 'code', verdict: 'changes', findings: 2, open: 1 }, { axis: 'security', verdict: 'approve', findings: 0, open: 0 }] }],
  });
});

test("a concept's details hold its map and a decision's its text, each empty until written", async () => {
  const { records, exportFolder } = await recordsOn();
  const reader = createItemDetails(null, () => undefined, { records, exportFolder });
  const concept = records.create({ title: 'Cloud', repository: WEB, kind: 'concept' });
  const decision = records.create({ title: 'Relay', repository: WEB, kind: 'decision' });
  const recordOf = async (workId: string) => ((await reader.details(boardItem(workId))) as { record: { bodyKind: string; body: string } }).record;
  assert.deepEqual([(await recordOf(concept.workId)).bodyKind, (await recordOf(concept.workId)).body], ['map', '']);
  records.setBody(concept.workId, concept.revision, 'map', '## Destination\n\nStream anywhere.');
  records.setBody(decision.workId, decision.revision, 'decision', '# Relay\n\nBroker only?');
  assert.deepEqual([await recordOf(concept.workId), await recordOf(decision.workId)].map((r) => [r.bodyKind, r.body]),
    [['map', '## Destination\n\nStream anywhere.'], ['decision', '# Relay\n\nBroker only?']]);
});

test('export writes the files lar-work export writes, into the export folder', async () => {
  const { records, dir, exportFolder } = await recordsOn();
  const concept = records.create({ title: 'Cloud', repository: WEB, kind: 'concept' });
  records.setBody(concept.workId, concept.revision, 'map', '# Cloud map\n\nStream anywhere.');
  let decision = records.create({ title: 'Relay', repository: WEB, kind: 'decision' });
  decision = records.setBody(decision.workId, decision.revision, 'decision', '# Relay\n\nBroker only?');
  records.setParent(decision.workId, decision.revision, concept.workId);
  const command = join(dir, 'command');
  mkdirSync(command);
  exportMarkdown(records, concept.workId, command);

  const exported = await createItemDetails(null, () => undefined, { records, exportFolder }).exportMarkdown(boardItem(concept.workId));
  const files = (folder: string) => readdirSync(folder).sort().map((name) => [name, readFileSync(join(folder, name), 'utf8')]);
  assert.deepEqual((exported as { paths: string[] }).paths.sort(), readdirSync(command).sort().map((name) => join(exportFolder, name)));
  assert.deepEqual(files(exportFolder), files(command));
  assert.equal(files(exportFolder).length, 2);
});

test('export refuses work with nothing written, a second export of the same files and sample mode', async () => {
  const { records, exportFolder } = await recordsOn();
  const reader = createItemDetails(null, () => undefined, { records, exportFolder });
  const build = records.create({ title: 'Owner accounts', repository: WEB, kind: 'build' });
  const empty = await reader.exportMarkdown(boardItem(build.workId));
  assert.deepEqual(empty, { status: 409, error: `The work record ${build.workId} has nothing to export: no brief, decision, map or Dependency.` });
  records.setBody(build.workId, build.revision, 'brief', '# Owner accounts');
  assert.ok('paths' in await reader.exportMarkdown(boardItem(build.workId)));
  const again = await reader.exportMarkdown(boardItem(build.workId));
  assert.equal((again as { status: number }).status, 409);
  assert.match((again as { error: string }).error, /already exists/);
  assert.deepEqual(await createItemDetails('unused.json', (item) => item).exportMarkdown(boardItem(build.workId)), { status: 403, error: 'Exporting is disabled in sample mode.' });
});
