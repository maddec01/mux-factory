import { effectiveVocabulary } from '@lar-factory/shared';
import { test, type TestContext } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRepositoryList, saveOnboarding } from '../config/repository-config.ts';
import { readRepositorySetups, setOverride } from '../config/repository-settings.ts';
import { type SaveReads, saveSetup } from './save-setup.ts';

const ANSWERS = {
  projectId: 'lar-web', role: 'Web client', itemSource: { kind: 'issues' }, domainDocs: { kind: 'private' }, skills: ['web-review'],
  consent: ['push-branch', 'open-pr', 'tag-ticket'],
};

async function dataDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'lar save setup test '));
  t.onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Reads that find no .lar-factory.json and push access without triage, unless `parts` say otherwise. */
const reads = (parts: Partial<SaveReads> = {}): SaveReads => ({
  shared: async () => null, access: async () => ({ 'push-branch': 'allowed', 'open-pr': 'allowed', 'tag-ticket': 'refused' }), ...parts,
});

test("saving onboarding's answers puts the repository on the board with them as its local settings, and no work paused", async (t) => {
  const dir = await dataDir(t);
  saveOnboarding({ repo: 'maddec01/lar-web', progress: { step: 'setup', done: ['project'], answers: { projectId: 'lar-web' } } }, null, dir);
  assert.deepEqual(await saveSetup({ repo: 'maddec01/lar-web', ...ANSWERS }, dir, reads()), { onboarding: [] });
  assert.deepEqual(readRepositoryList(dir), [{ repo: 'maddec01/lar-web' }]);
  assert.deepEqual(readRepositorySetups(dir), [{
    repo: 'maddec01/lar-web', projectId: 'lar-web', role: 'Web client', itemSource: { kind: 'issues' }, labels: [],
    domainDocs: { kind: 'private' }, skills: ['web-review'], ...effectiveVocabulary(),
    access: { 'push-branch': 'allowed', 'open-pr': 'allowed', 'publish-ticket': 'unverified', 'edit-ticket': 'unverified', 'tag-ticket': 'refused', 'comment-ticket': 'unverified', 'type-ticket': 'unverified', 'relate-ticket': 'unverified' },
    consent: ['push-branch', 'open-pr'], paused: [], shared: {}, connections: [],
    sources: { role: 'local', itemSource: 'local', labels: 'default', domainDocs: 'local', skills: 'local', vocabulary: 'default' },
  }]);
});

test('an answer equal to the shared default inherits it, so removing nothing and a later shared change apply', async (t) => {
  const dir = await dataDir(t);
  const shared = { defaults: { role: 'Web client', domainDocs: { kind: 'repository' as const, glossary: 'GLOSSARY.md', adrs: 'docs/adr' } } };
  await saveSetup({ repo: 'maddec01/lar-web', ...ANSWERS }, dir, reads({ shared: async () => shared }));
  const [setup] = readRepositorySetups(dir);
  assert.deepEqual([setup!.role, setup!.domainDocs], ['Web client', { kind: 'private' }]);
  // The role is inherited, so clearing the domain-doc override shows the shared location; the role was never an override.
  setOverride('maddec01/lar-web', 'domainDocs', undefined, dir);
  setOverride('maddec01/lar-web', 'role', undefined, dir);
  assert.deepEqual(readRepositorySetups(dir)[0]!.domainDocs, shared.defaults.domainDocs);
  assert.equal(readRepositorySetups(dir)[0]!.role, 'Web client');
});

test('an Azure DevOps repository saves its team, and an answer that does not fit the provider is refused with no write', async (t) => {
  const dir = await dataDir(t);
  const repo = 'contoso/Retail/shop';
  const wrong = await saveSetup({ repo, ...ANSWERS }, dir, reads());
  assert.deepEqual(wrong, { status: 400, error: 'contoso/Retail/shop: field itemSource must name the Azure DevOps team whose board the board reads.' });
  assert.deepEqual(readRepositoryList(dir), []);
  await saveSetup({ repo, ...ANSWERS, itemSource: { kind: 'azure-board', team: 'Retail Team' } }, dir, reads());
  assert.deepEqual(readRepositorySetups(dir)[0]!.itemSource, { kind: 'azure-board', team: 'Retail Team' });
});

test('a body missing an answer is a 400, and a read that fails or a repository onboarded already writes nothing', async (t) => {
  const dir = await dataDir(t);
  const refused = { status: 400, error: 'Send the repository, its T3 project, role, item source, domain-doc location, skills and write consent.' };
  for (const body of [{ ...ANSWERS }, { repo: 'maddec01/lar-web', ...ANSWERS, consent: ['merge'] }, { repo: 'maddec01/lar-web', ...ANSWERS, skills: 'all' },
    { repo: 'maddec01/lar-web', ...ANSWERS, domainDocs: { kind: 'repository' } }, { repo: 'maddec01/lar-web', ...ANSWERS, projectId: undefined }]) {
    assert.deepEqual(await saveSetup(body, dir, reads()), refused, JSON.stringify(body));
  }
  const failed = await saveSetup({ repo: 'maddec01/lar-web', ...ANSWERS }, dir, reads({ shared: async () => { throw new Error('gh auth login'); } }));
  assert.deepEqual(failed, { status: 502, error: "Can't read maddec01/lar-web's .lar-factory.json: gh auth login" });
  assert.deepEqual(readRepositoryList(dir), []);
  await saveSetup({ repo: 'maddec01/lar-web', ...ANSWERS }, dir, reads());
  assert.deepEqual(await saveSetup({ repo: 'maddec01/lar-web', ...ANSWERS, role: 'API' }, dir, reads()), { status: 409, error: 'maddec01/lar-web is onboarded already.' });
  assert.equal(readRepositorySetups(dir)[0]!.role, 'Web client');
});

test("an access read that fails saves the setup with every operation unverified", async (t) => {
  const dir = await dataDir(t);
  await saveSetup({ repo: 'maddec01/lar-web', ...ANSWERS }, dir, reads({ access: async () => { throw new Error('HTTP 502'); } }));
  assert.deepEqual(readRepositorySetups(dir)[0]!.consent, ['push-branch', 'open-pr', 'tag-ticket']);
});

test("saving onboarding's Connections pairs the repository with each other onboarded repository, once, on this Mac only", async (t) => {
  const dir = await dataDir(t);
  await saveSetup({ repo: 'maddec01/lar-api', ...ANSWERS, projectId: 'lar-api', role: 'API server', connections: [] }, dir, reads());
  await saveSetup({ repo: 'maddec01/lar-web', ...ANSWERS, connections: ['maddec01/lar-api', 'maddec01/lar-ios'] }, dir, reads());
  const connections = () => readRepositorySetups(dir).map((s) => [s.repo, s.connections]);
  assert.deepEqual(connections(), [['maddec01/lar-api', ['maddec01/lar-web']], ['maddec01/lar-web', ['maddec01/lar-api']]]);
  const file = JSON.parse(await readFile(join(dir, 'repository-settings.json'), 'utf8')) as { connections: unknown; repositories: { settings: object }[] };
  assert.deepEqual(file.connections, [['maddec01/lar-api', 'maddec01/lar-web']]);
  assert.ok(file.repositories.every((e) => !JSON.stringify(e.settings).includes('connections')), 'no Connection goes in the shared or local settings');
  assert.deepEqual(await saveSetup({ repo: 'maddec01/lar-web', ...ANSWERS, connections: 'all' }, dir, reads()),
    { status: 400, error: 'Send the repository, its T3 project, role, item source, domain-doc location, skills and write consent.' });
});
