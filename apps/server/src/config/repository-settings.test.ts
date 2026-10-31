import { effectiveVocabulary } from '@lar-factory/shared';
import { test, type TestContext } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeAzRepos } from '../azure/fake-az.ts';
import { agentSetupWrites } from '../onboarding/agent-setup.ts';
import { readRepositoryList, saveOnboarded, saveOnboarding } from './repository-config.ts';
import {
  acceptSetup, applySharedDefaults, changeRepositorySettings, readOnboardedConfigs, readRepositorySetups, recheckAccess, recordAccess, setConsent, setOverride, sharedDefaultsOf,
} from './repository-settings.ts';

const REPO = 'maddec01/lar-apple';
const AZURE = 'contoso/Fabrikam/lar-api';

/** A data folder whose list names `entries`, each a repository or its whole entry. */
async function dataDir(t: TestContext, entries: (string | object)[] = [REPO]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'lar repository settings test '));
  t.onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const repositories = entries.map((entry) => typeof entry === 'string' ? { repo: entry } : entry);
  await writeFile(join(dir, 'repository-settings.json'), JSON.stringify({ repositories }));
  return dir;
}

/** A gh that answers the contents call for each repository in `files`, and 404s for any other. */
function ghWith(files: Record<string, unknown>): (args: string[]) => Promise<string> {
  return async (args) => {
    const repo = /^repos\/([^/]+\/[^/]+)\/contents\/\.lar-factory\.json$/.exec(args[1] ?? '')?.[1];
    if (!repo || !(repo in files)) throw new Error(`gh api ${args[1]} failed: gh: Not Found (HTTP 404)`);
    const file = files[repo];
    return typeof file === 'string' ? file : JSON.stringify(file);
  };
}

const setupOf = (dir: string, repo = REPO) => readRepositorySetups(dir).find((s) => s.repo === repo)!;

test('a repository with no Repository config and no local settings works from the defaults', async (t) => {
  const dir = await dataDir(t, [REPO, AZURE]);
  assert.deepEqual(setupOf(dir), {
    repo: REPO, role: '', itemSource: { kind: 'issues' }, labels: [], domainDocs: { kind: 'private' }, skills: [], ...effectiveVocabulary(),
    access: { 'push-branch': 'unverified', 'open-pr': 'unverified', 'publish-ticket': 'unverified', 'edit-ticket': 'unverified', 'tag-ticket': 'unverified', 'comment-ticket': 'unverified', 'type-ticket': 'unverified', 'relate-ticket': 'unverified' },
    consent: [], paused: [], shared: {}, connections: [],
    sources: { role: 'default', itemSource: 'default', labels: 'default', domainDocs: 'default', skills: 'default', vocabulary: 'default' },
  });
  // An Azure DevOps repository has no item source until a team is named.
  assert.equal(setupOf(dir, AZURE).itemSource, null);
});

test('shared defaults sit beneath local overrides, and removing an override inherits the shared default again', async (t) => {
  const dir = await dataDir(t);
  applySharedDefaults(REPO, { defaults: { role: 'Apple app', skills: ['swift-style'], labels: ['area'] } }, dir);
  setOverride(REPO, 'role', 'My Apple client', dir);
  assert.equal(setupOf(dir).role, 'My Apple client');
  assert.deepEqual(setupOf(dir).skills, ['swift-style']);
  applySharedDefaults(REPO, { defaults: { role: 'The Apple app', skills: [] } }, dir);
  assert.equal(setupOf(dir).role, 'My Apple client');
  assert.deepEqual(setupOf(dir).skills, []);
  setOverride(REPO, 'role', undefined, dir);
  assert.equal(setupOf(dir).role, 'The Apple app');
});

test("each setting names where it comes from, and the setup keeps Repository config's defaults beside the overrides", async (t) => {
  const dir = await dataDir(t);
  applySharedDefaults(REPO, { defaults: { role: 'Apple app', labels: ['area'] } }, dir);
  setOverride(REPO, 'role', 'My Apple client', dir);
  const { sources, shared } = setupOf(dir);
  assert.deepEqual(sources, { role: 'local', itemSource: 'default', labels: 'shared', domainDocs: 'default', skills: 'default', vocabulary: 'default' });
  assert.deepEqual(shared, { role: 'Apple app', labels: ['area'] });
  setOverride(REPO, 'role', undefined, dir);
  assert.equal(setupOf(dir).sources.role, 'shared');
});

test('an invalid or unreadable Repository config keeps the last usable shared defaults and says why; a removed one drops them', async (t) => {
  const dir = await dataDir(t);
  applySharedDefaults(REPO, { defaults: { role: 'Apple app' } }, dir);
  applySharedDefaults(REPO, { problem: ".lar-factory.json isn't valid JSON." }, dir);
  assert.equal(setupOf(dir).role, 'Apple app');
  assert.equal(setupOf(dir).sharedProblem, ".lar-factory.json isn't valid JSON.");
  applySharedDefaults(REPO, { defaults: { role: 'Apple app' } }, dir);
  assert.equal(setupOf(dir).sharedProblem, undefined);
  applySharedDefaults(REPO, null, dir);
  assert.equal(setupOf(dir).role, '');
});

test('an item-source or domain-doc-location change pauses until accepted, and other changes pause nothing', async (t) => {
  const dir = await dataDir(t, [AZURE]);
  const team = (name: string) => ({ kind: 'azure-board' as const, team: name });
  applySharedDefaults(AZURE, { defaults: { role: 'API', itemSource: team('API Team') } }, dir);
  applySharedDefaults(AZURE, { defaults: { role: 'The API', itemSource: team('API Team'), skills: ['tdd'] } }, dir);
  assert.deepEqual(setupOf(dir, AZURE).paused, []);
  applySharedDefaults(AZURE, { defaults: { itemSource: team('API Team'), domainDocs: { kind: 'repository', glossary: 'GLOSSARY.md', adrs: 'docs/adr' } } }, dir);
  assert.deepEqual(setupOf(dir, AZURE).paused, ['domainDocs']);
  setOverride(AZURE, 'itemSource', team('Platform Team'), dir);
  assert.deepEqual(setupOf(dir, AZURE).paused, ['itemSource', 'domainDocs']);
  acceptSetup(AZURE, dir);
  assert.deepEqual(setupOf(dir, AZURE).paused, []);
  // Changing back is a change too.
  setOverride(AZURE, 'itemSource', undefined, dir);
  assert.deepEqual(setupOf(dir, AZURE).paused, ['itemSource']);
});

test('an override that does not fit the repository is refused', async (t) => {
  const dir = await dataDir(t);
  assert.throws(() => setOverride(REPO, 'itemSource', { kind: 'azure-board', team: 'Team' }, dir),
    { message: `${REPO}: field itemSource must be {"kind": "issues"}.` });
});

test('access stays unverified until an operation is tried, and consent is kept but limited to the access available', async (t) => {
  const dir = await dataDir(t);
  setConsent(REPO, ['push-branch', 'open-pr', 'tag-ticket'], dir);
  recordAccess(REPO, 'push-branch', 'allowed', dir);
  recordAccess(REPO, 'tag-ticket', 'refused', dir);
  const setup = setupOf(dir);
  assert.equal(setup.access['push-branch'], 'allowed');
  assert.equal(setup.access['tag-ticket'], 'refused');
  assert.equal(setup.access['open-pr'], 'unverified');
  assert.deepEqual(setup.consent, ['push-branch', 'open-pr']);
  // After a credential change every operation is unverified again, and the consent the user gave comes back.
  recheckAccess(REPO, dir);
  assert.equal(setupOf(dir).access['tag-ticket'], 'unverified');
  assert.deepEqual(setupOf(dir).consent, ['push-branch', 'open-pr', 'tag-ticket']);
});

test('Repository config never supplies credentials or consent', () => {
  assert.deepEqual(sharedDefaultsOf({ role: 'Apple app', consent: ['open-pr'], access: { 'open-pr': 'allowed' } }, false), { defaults: { role: 'Apple app' } });
});

test('a Repository config with every field optional reads its shared defaults, and a wrong field is a problem', () => {
  assert.deepEqual(sharedDefaultsOf({}, false), { defaults: {} });
  assert.deepEqual(sharedDefaultsOf({ version: 1, role: 'API', itemSource: { kind: 'azure-board', team: 'Team' }, show: 'some', labels: ['area'],
    domainDocs: { kind: 'repository', glossary: 'GLOSSARY.md', adrs: 'docs/adr' }, skills: ['tdd'] }, true), { defaults: {
    role: 'API', itemSource: { kind: 'azure-board', team: 'Team' }, labels: ['area'],
    domainDocs: { kind: 'repository', glossary: 'GLOSSARY.md', adrs: 'docs/adr' }, skills: ['tdd'] } });
  for (const [raw, azure] of [[{ role: 3 }, false], [{ itemSource: { kind: 'issues' } }, true], [{ itemSource: { kind: 'azure-board' } }, true],
    [{ labels: 'area' }, false], [{ domainDocs: { kind: 'repository' } }, false], [{ skills: [1] }, false]] as const) {
    assert.ok('problem' in sharedDefaultsOf(raw, azure), JSON.stringify(raw));
  }
});

test('settings survive a restart and an onboarding save, and the file keeps them under each entry', async (t) => {
  const dir = await dataDir(t, []);
  saveOnboarding({ repo: REPO, progress: { step: 'setup', done: ['project'], answers: { projectId: 'lar-apple' } } }, null, dir);
  setConsent(REPO, ['open-pr'], dir);
  saveOnboarded(REPO, null, dir);
  setOverride(REPO, 'role', 'Apple app', dir);
  assert.deepEqual(setupOf(dir).consent, ['open-pr']);
  assert.equal(setupOf(dir).role, 'Apple app');
  const file = JSON.parse(await readFile(join(dir, 'repository-settings.json'), 'utf8'));
  assert.deepEqual(file.repositories[0].settings.overrides, { role: 'Apple app' });
});

test("a list entry whose settings aren't usable is refused, naming its entry", async (t) => {
  const dir = await dataDir(t, []);
  await writeFile(join(dir, 'repository-settings.json'), JSON.stringify({ repositories: [{ repo: REPO, settings: { consent: ['fly'] } }] }));
  assert.throws(() => readRepositorySetups(dir), { message: `${join(dir, 'repository-settings.json')}: repositories[0] has local settings it can't use.` });
});

test('settings for a repository the list does not name are refused', async (t) => {
  const dir = await dataDir(t, []);
  assert.throws(() => setConsent(REPO, ['open-pr'], dir), { message: `${REPO} is not on this Mac's list.` });
});

test('a repository with no .lar-factory.json is on the board from its local settings', async (t) => {
  const dir = await dataDir(t, ['maddec01/missing', 'maddec01/lar-factory']);
  const gh = ghWith({ 'maddec01/lar-factory': { version: 1, role: 'The factory', show: 'opted-in', labels: ['area'] } });
  const { configs, problems } = await readOnboardedConfigs(readRepositoryList(dir), gh, dir);
  assert.deepEqual(configs, [
    { repo: 'maddec01/missing', version: 2, role: '', itemSource: { kind: 'issues' }, labels: [] },
    { repo: 'maddec01/lar-factory', version: 1, role: 'The factory', itemSource: { kind: 'issues' }, labels: ['area'] },
  ]);
  assert.deepEqual(problems, []);
});

test('a wrong .lar-factory.json keeps the last usable setup on the board and says why', async (t) => {
  const dir = await dataDir(t, ['maddec01/lar-factory']);
  await readOnboardedConfigs(readRepositoryList(dir), ghWith({ 'maddec01/lar-factory': { role: 'The factory' } }), dir);
  for (const [file, problem] of [['{ broken', ".lar-factory.json isn't valid JSON."], [{ labels: 'area' }, '.lar-factory.json field labels must be an array of strings.']] as const) {
    const { configs, problems } = await readOnboardedConfigs(readRepositoryList(dir), ghWith({ 'maddec01/lar-factory': file }), dir);
    assert.deepEqual(configs.map((c) => c.role), ['The factory']);
    assert.deepEqual(problems, [{ repo: 'maddec01/lar-factory', kind: 'shared-config', problem }]);
  }
});

test('a repository still onboarding reads no config and has no problem', async (t) => {
  const read: string[] = [];
  const gh = async (args: string[]) => {
    read.push(args[1]!);
    if (args[1]?.endsWith('/.lar-factory.json')) return JSON.stringify({ role: 'The factory' });
    throw new Error('Not Found (HTTP 404)');
  };
  const dir = await dataDir(t, ['maddec01/lar-factory', { repo: 'maddec01/lar-apple', onboarding: { step: 'setup', done: ['project'], answers: { projectId: 'lar-apple' } } }]);
  const { configs, problems } = await readOnboardedConfigs(readRepositoryList(dir), gh, dir);
  assert.deepEqual(configs.map((c) => c.repo), ['maddec01/lar-factory']);
  assert.deepEqual(problems, []);
  assert.equal(read[0], 'repos/maddec01/lar-factory/contents/.lar-factory.json');
});

test("an Azure repository az can't read keeps its last usable setup with az's problem, and one with no team stays off the board", async (t) => {
  const dir = await dataDir(t, ['maddec01/lar-factory', 'contoso/Fabrikam/lar-api', 'contoso/Fabrikam/lar-web']);
  const team = { role: 'API', itemSource: { kind: 'azure-board', team: 'API Team' } };
  const reads = fakeAzRepos({ files: { '/.lar-factory.json': JSON.stringify(team) }, fail: (args) => args.includes('repositoryId=lar-web') ? new Error('az devops invoke failed: TF400813: The user is not authorized to access this resource.') : undefined });
  const gh = ghWith({ 'maddec01/lar-factory': { role: 'The factory' } });
  const run = (azure: (args: string[]) => Promise<string>) => (args: string[]) => args[0] === 'devops' ? azure(args) : gh(args);
  await readOnboardedConfigs(readRepositoryList(dir), run(reads.run), dir);
  const loggedOut = fakeAzRepos({ fail: () => new Error('az devops invoke failed: Please run az login to setup account.') });
  const { configs, problems } = await readOnboardedConfigs(readRepositoryList(dir), run(loggedOut.run), dir);
  assert.deepEqual(configs.map((c) => [c.repo, c.itemSource]), [['maddec01/lar-factory', { kind: 'issues' }], ['contoso/Fabrikam/lar-api', team.itemSource]]);
  assert.deepEqual(problems, [
    { repo: 'contoso/Fabrikam/lar-api', kind: 'shared-config', problem: 'az is logged out. Run az login.' },
    { repo: 'contoso/Fabrikam/lar-web', problem: 'az is logged out. Run az login.' },
  ]);
});

test('a gh failure other than a 404 still fails the whole read', async (t) => {
  const dir = await dataDir(t, ['maddec01/lar-factory']);
  const gh = async () => { throw new Error('gh api failed: To get started with GitHub CLI, please run:  gh auth login'); };
  await assert.rejects(readOnboardedConfigs(readRepositoryList(dir), gh, dir), /gh auth login/);
});

test('stale factory guidance warns without removing a usable repository; current and personal guidance stay quiet', async (t) => {
  for (const [path, content, stale] of [
    ['AGENTS.md', '## Agent skills\nUse `to-tickets`.', true],
    ['docs/agents/domain.md', 'Use the `domain-modeling` skill.', true],
    ['AGENTS.md', '## Personal tools\nUse `tdd`.\n## Agent skills\nUse `lar-shape` and `lar-build`.', false],
    ['docs/agents/issue-tracker.md', 'Read and change a work record with `lar-work`.', false],
    ['docs/agents/domain.md', 'Read lar-build skills/domain-modeling/SKILL.md.', false],
  ] as const) {
    const run = async (args: string[]) => {
      if (args[1]?.endsWith('/.lar-factory.json')) return JSON.stringify({ role: 'API' });
      if (args[1]?.endsWith('/' + path)) return content;
      throw new Error('Not Found (HTTP 404)');
    };
    const result = await readOnboardedConfigs([{ repo: 'owner/api' }], run, await dataDir(t, ['owner/api']));
    assert.equal(result.configs.length, 1);
    assert.equal(result.problems.length, stale ? 1 : 0);
    if (stale) assert.match(result.problems[0]!.problem, /lar-shape.*lar-build/);
  }
});

test('fresh onboarding guidance produces no migration warning', async (t) => {
  const files = new Map(agentSetupWrites({}, 'GitHub').map(({ path, content }) => [path, content]));
  const run = async (args: string[]) => {
    const path = args[1]!.split('/contents/')[1]!;
    if (path === '.lar-factory.json') return JSON.stringify({ role: 'API' });
    if (files.has(path)) return files.get(path)!;
    throw new Error('Not Found (HTTP 404)');
  };
  const result = await readOnboardedConfigs([{ repo: 'owner/api' }], run, await dataDir(t, ['owner/api']));
  assert.equal(result.configs.length, 1);
  assert.deepEqual(result.problems, []);
});

test('optional guidance failures preserve valid configs and report a retryable warning', async (t) => {
  for (const repo of ['owner/api', 'contoso/Fabrikam/lar-api']) {
    const run = async (args: string[]) => {
      if (args.some((arg) => arg.includes('.lar-factory.json'))) return JSON.stringify({ role: 'API' });
      throw new Error('Temporary guidance read failure');
    };
    const azure = fakeAzRepos({ files: { '/.lar-factory.json': JSON.stringify({ role: 'API', itemSource: { kind: 'azure-board', team: 'Team' } }) },
      fail: (args) => args.some((arg) => arg.includes('.lar-factory.json')) ? undefined : new Error('Temporary guidance read failure') });
    const result = await readOnboardedConfigs([{ repo }], repo.includes('Fabrikam') ? azure.run : run, await dataDir(t, [repo]));
    assert.deepEqual(result.configs.map((config) => config.repo), [repo]);
    assert.equal(result.problems.length, 1);
    assert.equal(result.problems[0]?.kind, 'agent-guidance');
    assert.match(result.problems[0]!.problem, /Could not check agent guidance.*Temporary guidance read failure.*Refresh/);
  }
});

test('reading an unchanged Repository config again leaves the list file alone', async (t) => {
  const dir = await dataDir(t);
  applySharedDefaults(REPO, { defaults: { role: 'Apple app' } }, dir);
  const file = join(dir, 'repository-settings.json');
  await writeFile(file, `${await readFile(file, 'utf8')} `);
  applySharedDefaults(REPO, { defaults: { role: 'Apple app' } }, dir);
  assert.match(await readFile(file, 'utf8'), / $/);
});

test("Settings' changes set and remove an override, accept a changed setup and recheck access, answering the setup they make", async (t) => {
  const dir = await dataDir(t, [AZURE]);
  const team = (name: string) => ({ kind: 'azure-board' as const, team: name });
  applySharedDefaults(AZURE, { defaults: { role: 'API', itemSource: team('API Team') } }, dir);
  recordAccess(AZURE, 'open-pr', 'refused', dir);
  const set = changeRepositorySettings({ repo: AZURE, change: 'override', key: 'itemSource', value: team('Platform Team') }, dir);
  assert.ok('setup' in set);
  assert.deepEqual([set.setup.itemSource, set.setup.sources.itemSource, set.setup.paused], [team('Platform Team'), 'local', ['itemSource']]);
  const accepted = changeRepositorySettings({ repo: AZURE, change: 'accept' }, dir);
  assert.deepEqual('setup' in accepted && accepted.setup.paused, []);
  const removed = changeRepositorySettings({ repo: AZURE, change: 'override', key: 'itemSource' }, dir);
  assert.deepEqual('setup' in removed && [removed.setup.itemSource, removed.setup.sources.itemSource], [team('API Team'), 'shared']);
  const rechecked = changeRepositorySettings({ repo: AZURE, change: 'recheck' }, dir);
  assert.equal('setup' in rechecked && rechecked.setup.access['open-pr'], 'unverified');
});

test("Settings' consent change sets the operations offered within the access available, keeping consent a refusal hides", async (t) => {
  const dir = await dataDir(t);
  setConsent(REPO, ['open-pr', 'tag-ticket'], dir);
  recordAccess(REPO, 'tag-ticket', 'refused', dir);
  const changed = changeRepositorySettings({ repo: REPO, change: 'consent', value: ['push-branch'] }, dir);
  assert.deepEqual('setup' in changed && changed.setup.consent, ['push-branch']);
  assert.deepEqual(changeRepositorySettings({ repo: REPO, change: 'consent', value: ['tag-ticket'] }, dir),
    { status: 400, error: `The credentials for ${REPO} refuse tag-ticket, so the board can't offer it.` });
  assert.deepEqual(changeRepositorySettings({ repo: REPO, change: 'consent', value: ['fly'] }, dir),
    { status: 400, error: 'Send the operations to offer.' });
  // The consent given before access was refused comes back once a recheck finds the access again.
  recheckAccess(REPO, dir);
  assert.deepEqual(setupOf(dir).consent, ['push-branch', 'tag-ticket']);
});

test("Settings' changes refuse a setting Repository config can't share, a value that doesn't fit and a repository not onboarded", async (t) => {
  const progress = { step: 'setup', done: ['project'], answers: { projectId: 'lar-web' } };
  const dir = await dataDir(t, [REPO, { repo: 'maddec01/lar-web', onboarding: progress }]);
  assert.deepEqual(changeRepositorySettings({ repo: REPO, change: 'override', key: 'consent', value: ['open-pr'] }, dir),
    { status: 400, error: 'Send a setting Repository config can share.' });
  assert.deepEqual(changeRepositorySettings({ repo: REPO, change: 'override', key: 'show', value: 'all' }, dir),
    { status: 400, error: 'Send a setting Repository config can share.' }, 'the old show setting is gone');
  assert.deepEqual(changeRepositorySettings({ repo: REPO, change: 'override', key: 'labels', value: 'area' }, dir),
    { status: 400, error: `${REPO}: field labels must be an array of strings.` });
  assert.deepEqual(changeRepositorySettings({ repo: REPO, change: 'fly' }, dir), { status: 400, error: 'Send the repository and the change to its settings.' });
  assert.deepEqual(changeRepositorySettings({ repo: 'maddec01/lar-web', change: 'recheck' }, dir), { status: 409, error: 'maddec01/lar-web is still onboarding.' });
  assert.equal(setupOf(dir).sources.labels, 'default');
});

test('Vocabulary inherits per term, preserves explicit nothing and restores inheritance when removed', async (t) => {
  const dir = await dataDir(t);
  applySharedDefaults(REPO, { defaults: { vocabulary: { build: { type: 'Task', labels: ['delivery'] }, bug: { type: 'Bug', labels: [] } } } }, dir);
  setOverride(REPO, 'vocabulary', { build: { type: null, labels: [] } }, dir);
  assert.deepEqual(setupOf(dir).vocabulary.build, { type: null, labels: [] });
  assert.deepEqual(setupOf(dir).vocabulary.bug, { type: 'Bug', labels: [] });
  assert.equal(setupOf(dir).vocabularySources.build, 'local');
  assert.equal(setupOf(dir).vocabularySources.bug, 'shared');
  assert.equal(setupOf(dir).vocabularySources.feature, 'default');
  setOverride(REPO, 'vocabulary', {}, dir);
  assert.deepEqual(setupOf(dir).vocabulary.build, { type: 'Task', labels: ['delivery'] });
  assert.equal(setupOf(dir).vocabularySources.build, 'shared');
});

test('malformed Vocabulary keeps the last usable shared config and consent remains local', async (t) => {
  const dir = await dataDir(t);
  applySharedDefaults(REPO, { defaults: { vocabulary: { concept: { type: 'Epic', labels: [] } } } }, dir);
  for (const vocabulary of [{ build: null }, { slice: { type: 'Task', labels: [] } }, { bug: { type: ['Bug'], labels: [] } }, { build: { type: null, labels: [3] } }]) {
    const read = sharedDefaultsOf({ vocabulary, consent: ['publish-ticket'] }, false);
    assert.ok('problem' in read);
    applySharedDefaults(REPO, read, dir);
    assert.equal(setupOf(dir).vocabulary.concept.type, 'Epic');
    assert.match(setupOf(dir).sharedProblem!, /vocabulary/);
    assert.deepEqual(setupOf(dir).consent, []);
  }
});

test('Settings edits and removes one Vocabulary override without changing the other terms or consent', async (t) => {
  const dir = await dataDir(t);
  applySharedDefaults(REPO, { defaults: { vocabulary: { bug: { type: 'Bug', labels: ['defect'] } } } }, dir);
  setOverride(REPO, 'vocabulary', { build: { type: 'Task', labels: [] } }, dir);
  const saved = changeRepositorySettings({ repo: REPO, change: 'vocabulary', key: 'bug', value: { type: null, labels: [] } }, dir);
  assert.ok('setup' in saved);
  assert.deepEqual(saved.setup.vocabulary.bug, { type: null, labels: [] });
  assert.equal(saved.setup.vocabulary.build.type, 'Task');
  assert.deepEqual(saved.setup.consent, []);
  changeRepositorySettings({ repo: REPO, change: 'vocabulary', key: 'bug' }, dir);
  assert.equal(setupOf(dir).vocabulary.bug.type, 'Bug');
  assert.equal(setupOf(dir).vocabulary.build.type, 'Task');
  assert.ok('error' in changeRepositorySettings({ repo: REPO, change: 'vocabulary', key: 'slice' }, dir));
});

test('permission to offer ticket creation grants neither edits, comments, terms nor relationships', async (t) => {
  const dir = await dataDir(t);
  const changed = changeRepositorySettings({ repo: REPO, change: 'consent', value: ['publish-ticket'] }, dir);
  assert.ok('setup' in changed);
  assert.deepEqual(changed.setup.consent, ['publish-ticket']);
  for (const operation of ['comment-ticket', 'edit-ticket', 'tag-ticket', 'type-ticket', 'relate-ticket'] as const) {
    assert.equal(changed.setup.access[operation], 'unverified');
    assert.equal(changed.setup.consent.includes(operation), false);
  }
});
