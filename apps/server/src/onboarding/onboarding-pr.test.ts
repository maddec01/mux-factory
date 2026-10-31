import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import type { OnboardingPrChange } from '@lar-factory/shared';
import { REPO_URL, fakeAzRepos } from '../azure/fake-az.ts';
import { createPrOpener, previewOnboardingPr } from './onboarding-pr.ts';

const config = { role: 'Web client', itemSource: { kind: 'issues' }, skills: ['web-review'] };
const PR = 'https://github.com/maddec01/lar-web/pull/14';

/** The gh boundary's fields, read from JSON stdin for tree requests and flags for other requests. */
const inputs = new WeakMap<string[], string>();
const field = (args: string[], name: string): string[] => {
  const input = inputs.get(args);
  if (input) {
    const payload = JSON.parse(input) as { base_tree: string; tree: Record<string, string>[] };
    if (name === 'base_tree') return [payload.base_tree];
    const key = /^tree\[\]\[(.+)\]$/.exec(name)?.[1];
    if (key) return payload.tree.flatMap((entry) => typeof entry[key] === 'string' ? [entry[key]] : []);
  }
  return args.filter((a, i) => /^-[fF]$/.test(args[i - 1] ?? '') && a.startsWith(`${name}=`)).map((a) => a.slice(name.length + 1));
};

const RULES = '# lar-web\n\n- Push to main when done.\n';

/**
 * A gh that records each call and answers it like GitHub, failing the calls `fails` names, by their first two args or
 * their path, with its message. The default branch holds `files`; `branches` are the lar-factory/ branches the
 * repository has, each with its open PR's URL or null.
 */
function gh(fails: Record<string, string> = {}, branches: Record<string, string | null> = {}, files: Record<string, string> = { 'AGENTS.md': RULES }) {
  const calls: string[][] = [];
  const run = async (args: string[], input?: string) => {
    if (input !== undefined) inputs.set(args, input);
    calls.push(args);
    const failure = fails[args.slice(0, 2).join(' ')] ?? fails[args[1]!];
    if (failure) throw new Error(failure);
    if (args[1] === 'repos/maddec01/lar-web') return 'main\n';
    if (args[1] === 'repos/maddec01/lar-web/git/ref/heads/main') return 'abc123\n';
    if (args[1] === 'repos/maddec01/lar-web/git/trees/abc123?recursive=1') {
      return JSON.stringify({ sha: 'tree0', truncated: false, tree: Object.keys(files).map((path) => ({ path, mode: '100644', type: 'blob', sha: `blob:${path}` })) });
    }
    const blob = /\/git\/blobs\/blob:(.+)$/.exec(args[1]!)?.[1];
    if (blob) return files[blob]!;
    if (args[1] === 'repos/maddec01/lar-web/git/trees') return 'tree1\n';
    if (args[1] === 'repos/maddec01/lar-web/git/commits') return 'commit1\n';
    const ref = /\/git\/ref\/heads\/(lar-factory\/.+)$/.exec(args[1]!)?.[1];
    if (ref) {
      if (!(ref in branches)) throw new Error('gh: Not Found (HTTP 404)');
      return 'def456\n';
    }
    if (args[0] === 'pr' && args[1] === 'list') return `${branches[args[args.indexOf('--head') + 1]!] ?? ''}\n`;
    if (args[0] === 'pr' && args[1] === 'create') return `${PR}\n`;
    return '{}';
  };
  return { calls, run };
}

const picks = { clashes: [], skills: {} };
const guidance = { drop: [], guidance: true };
const pushRule = { id: 'push', file: 'AGENTS.md', line: 3, ticked: true, reason: 'It pushes to main, and the factory opens PRs.',
  edit: { kind: 'lines', remove: ['- Push to main when done.'], add: ['- Open a PR when done.'] } };
const writes = (calls: string[][]) => calls.filter((args) => args.includes('POST') || args.includes('PATCH') || args[1] === 'create');

test('opening the PR makes one commit on the default branch\'s head with the chosen edits, puts lar-factory/onboarding on it and opens the PR', async () => {
  const { calls, run } = gh({}, {}, { 'AGENTS.md': RULES, 'CONTEXT.md': '# Terms\n', '.scratch/todo.md': 'x' });
  const opened = await createPrOpener(run)({ repo: 'maddec01/lar-web', edits: { drop: [], config, guidance: true }, picks: { skills: {}, clashes: [pushRule,
    { id: 'context', file: 'CONTEXT.md', ticked: true, reason: 'Old name.', edit: { kind: 'rename', to: 'GLOSSARY.md' } },
    { id: 'scratch', file: '.scratch/', ticked: true, reason: 'Local tracker.', edit: { kind: 'delete' } }] } });
  assert.deepEqual(opened, { prUrl: PR });
  const [tree, commit, branch, create] = writes(calls);
  assert.deepEqual(field(tree!, 'base_tree'), ['tree0']);
  assert.deepEqual(field(tree!, 'tree[][path]').sort(), ['.lar-factory.json', '.scratch/todo.md', 'AGENTS.md', 'CONTEXT.md', 'GLOSSARY.md',
    'docs/agents/domain.md', 'docs/agents/issue-tracker.md', 'docs/agents/triage-labels.md']);
  assert.ok(field(tree!, 'tree[][content]').some((text) => text.startsWith('# lar-web\n\n- Open a PR when done.\n\n## Agent skills')));
  assert.deepEqual(JSON.parse(field(tree!, 'tree[][content]').find((text) => text.includes('"version"'))!),
    { version: 2, role: 'Web client', itemSource: { kind: 'issues' }, skills: ['web-review'] });
  assert.deepEqual([field(commit!, 'tree'), field(commit!, 'parents[]')], [['tree1'], ['abc123']]);
  assert.deepEqual([field(branch!, 'ref'), field(branch!, 'sha')], [['refs/heads/lar-factory/onboarding'], ['commit1']]);
  assert.deepEqual([create![create!.indexOf('--base') + 1], create![create!.indexOf('--head') + 1]], ['main', 'lar-factory/onboarding']);
  const body = create![create!.indexOf('--body') + 1]!;
  for (const line of ["- Writes Lar Factory's `## Agent skills` block in `AGENTS.md`.", '- Adds `docs/agents/domain.md`.',
    '- Adds `.lar-factory.json`, the Repository config Lar Factory reads for this repository.',
    '- Edits `AGENTS.md` at line 3: It pushes to main, and the factory opens PRs.', '- Renames `CONTEXT.md` to `GLOSSARY.md`.', '- Deletes `.scratch/`.']) {
    assert.ok(body.includes(line), line);
  }
  assert.ok(!calls.some((args) => args[0] === 'label' || /\/labels\b/.test(args[1]!) || args.includes('--add-label')), 'onboarding touches no label');
});

test('dropped factory files go in one commit that removes them, keeping the rest of each file', async () => {
  const files = { '.lar-factory.json': '{}\n', 'AGENTS.md': '# lar-web\n\n## Agent skills\n\nUse lar-shape.\n', 'docs/agents/domain.md': 'Old.\n' };
  const { calls, run } = gh({}, {}, files);
  assert.deepEqual(await createPrOpener(run)({ repo: 'maddec01/lar-web', edits: { drop: ['config', 'agent-skills', 'agent-docs'] } }), { prUrl: PR });
  const [tree, , , create] = writes(calls);
  assert.deepEqual(field(tree!, 'tree[][path]').sort(), ['.lar-factory.json', 'AGENTS.md', 'docs/agents/domain.md']);
  assert.deepEqual(field(tree!, 'tree[][content]'), ['# lar-web\n\n']);
  const body = create![create!.indexOf('--body') + 1]!;
  assert.ok(body.includes("- Removes Lar Factory's `## Agent skills` block in `AGENTS.md`."));
  assert.ok(body.includes('- Deletes `docs/agents/domain.md`.'));
});

test('no chosen edit opens no PR, writing nothing', async () => {
  const { calls, run } = gh();
  assert.deepEqual(await createPrOpener(run)({ repo: 'maddec01/lar-web', edits: { drop: [] } }),
    { status: 409, error: 'maddec01/lar-web has no repository edits to open a PR for.' });
  assert.deepEqual(writes(calls), []);
});

test('an edit whose lines moved on the default branch fails with its file and line, and writes nothing', async () => {
  const { calls, run } = gh({}, {}, { 'AGENTS.md': '# lar-web\n\nRead the README.\n\n- Push to main when done.\n' });
  assert.deepEqual(await createPrOpener(run)({ repo: 'maddec01/lar-web', edits: guidance, picks: { clashes: [pushRule], skills: {} } }),
    { status: 409, error: 'The text at line 3 in AGENTS.md has changed. Uncheck this change in Cleanup or check instructions again.' });
  assert.deepEqual(writes(calls), []);
});

test('a skill renamed in the PR moves its folder and names itself anew in its SKILL.md', async () => {
  const { calls, run } = gh({}, {}, { '.claude/skills/lar-build/SKILL.md': '---\nname: lar-build\n---\n' });
  await createPrOpener(run)({ repo: 'maddec01/lar-web', edits: { drop: [] },
    picks: { clashes: [], skills: { '.claude/skills/lar-build/': { kind: 'rename', name: 'web-review' } } } });
  const tree = writes(calls)[0]!;
  assert.ok(field(tree, 'tree[][path]').includes('.claude/skills/web-review/SKILL.md'));
  assert.ok(field(tree, 'tree[][content]').includes('---\nname: web-review\n---\n'));
  const create = writes(calls).at(-1)!;
  assert.ok(create[create.indexOf('--body') + 1]!.includes('- Renames `.claude/skills/lar-build/` to `.claude/skills/web-review/`.'));
});

test('a taken lar-factory/onboarding with an open PR is moved to the new commit and its PR reused with the new body, opening nothing', async () => {
  const reused = 'https://github.com/maddec01/lar-web/pull/9';
  const { calls, run } = gh({}, { 'lar-factory/onboarding': reused });
  assert.equal((await createPrOpener(run)({ repo: 'maddec01/lar-web', edits: guidance }) as { prUrl: string }).prUrl, reused);
  const [, , move, edit, ...rest] = writes(calls);
  assert.deepEqual(move!.slice(0, 4), ['api', 'repos/maddec01/lar-web/git/refs/heads/lar-factory/onboarding', '--method', 'PATCH']);
  assert.deepEqual([field(move!, 'sha'), field(move!, 'force')], [['commit1'], ['true']]);
  assert.equal(edit![3], 'repos/maddec01/lar-web/pulls/9');
  assert.match(field(edit!, 'body')[0]!, /^This PR:/);
  assert.deepEqual(rest, []);
});

test('a taken branch with no open PR moves on to the first free lar-factory/onboarding-N', async () => {
  const { calls, run } = gh({}, { 'lar-factory/onboarding': null, 'lar-factory/onboarding-2': null });
  assert.equal((await createPrOpener(run)({ repo: 'maddec01/lar-web', edits: guidance }) as { prUrl: string }).prUrl, PR);
  const refs = calls.filter((args) => args[1]!.includes('/git/ref/heads/lar-factory/')).map((args) => args[1]!.split('heads/')[1]);
  assert.deepEqual(refs, ['lar-factory/onboarding', 'lar-factory/onboarding-2', 'lar-factory/onboarding-3']);
  const create = calls.find((args) => args[1] === 'create')!;
  assert.equal(create[create.indexOf('--head') + 1], 'lar-factory/onboarding-3');
});

test("a failing gh call answers with gh's message; Retry goes on from the call that failed", async () => {
  for (const [call, after] of [['repos/maddec01/lar-web/git/commits', ['repos/maddec01/lar-web/git/commits', 'repos/maddec01/lar-web/git/ref/heads/lar-factory/onboarding',
    'repos/maddec01/lar-web/git/refs', 'create']], ['pr create', ['create']]] as const) {
    const fails: Record<string, string> = { [call]: `gh ${call} failed: HTTP 502` };
    const { calls, run } = gh(fails);
    const open = createPrOpener(run);
    assert.deepEqual(await open({ repo: 'maddec01/lar-web', edits: guidance }), { status: 502,
      error: `Can't open maddec01/lar-web's onboarding PR: gh ${call} failed: HTTP 502` });
    delete fails[call];
    calls.length = 0;
    assert.equal((await open({ repo: 'maddec01/lar-web', edits: guidance }) as { prUrl: string }).prUrl, PR);
    assert.deepEqual(calls.map((args) => args[1]), after);
  }
});

test('Retry with other edits after the commit was made starts again from the default branch, with only the new edits', async () => {
  const fails: Record<string, string> = { 'pr create': 'gh pr create failed: HTTP 502' };
  const { calls, run } = gh(fails);
  const open = createPrOpener(run);
  await open({ repo: 'maddec01/lar-web', edits: guidance, picks: { clashes: [pushRule], skills: {} } });
  delete fails['pr create'];
  calls.length = 0;
  assert.equal((await open({ repo: 'maddec01/lar-web', edits: guidance, picks }) as { prUrl: string }).prUrl, PR);
  assert.ok(calls.some((args) => args[1] === 'repos/maddec01/lar-web/git/ref/heads/main'));
  assert.ok(!field(writes(calls)[0]!, 'tree[][content]').some((text) => text.includes('Open a PR when done')));
});

test('the preview lists the changes the PR would make against the default branch, writing nothing', async () => {
  const { calls, run } = gh();
  const preview = await previewOnboardingPr({ repo: 'maddec01/lar-web', edits: { drop: [], config, guidance: true }, picks: { clashes: [pushRule], skills: {} } }, run);
  assert.ok('changes' in preview);
  assert.deepEqual(preview.changes.map(({ preview, ...change }) => change), [
    { kind: 'agent-skills', path: 'AGENTS.md' }, { kind: 'write', path: 'docs/agents/issue-tracker.md', created: true },
    { kind: 'write', path: 'docs/agents/triage-labels.md', created: true }, { kind: 'write', path: 'docs/agents/domain.md', created: true },
    { kind: 'write', path: '.lar-factory.json', created: true }, { kind: 'edit', path: 'AGENTS.md', line: 3, reason: pushRule.reason },
  ]);
  assert.deepEqual(writes(calls), []);
  assert.deepEqual(await previewOnboardingPr({ repo: 'maddec01/lar-web', edits: guidance }, gh({ 'repos/maddec01/lar-web': 'gh api failed: HTTP 502' }).run),
    { status: 502, error: "Can't read maddec01/lar-web's default branch: gh api failed: HTTP 502" });
});

test('a body without the repository and its edits, or with edits or picks that do not fit, is refused', async () => {
  const open = createPrOpener(gh().run);
  const refused = { status: 400, error: 'Send the repository, the factory files to drop, any additions and Clash picks.' };
  assert.deepEqual(await open({ repo: 'maddec01/lar-web' }), refused);
  assert.deepEqual(await open({ repo: 'lar-web', edits: guidance }), refused);
  assert.deepEqual(await open({ repo: 'maddec01/lar-web', edits: { drop: ['labels'] } }), refused);
  assert.deepEqual(await open({ repo: 'maddec01/lar-web', edits: { drop: [], guidance: 'yes' } }), refused);
  assert.deepEqual(await open({ repo: 'maddec01/lar-web', edits: { drop: [], config: { labels: 'area' } } }), refused);
  assert.deepEqual(await open({ repo: 'maddec01/lar-web', edits: guidance, picks: { clashes: [{ ...pushRule, line: undefined }], skills: {} } }), refused);
  assert.deepEqual(await open({ repo: 'maddec01/lar-web', edits: guidance, picks: { clashes: [], skills: { '.claude/skills/x/': { kind: 'rename', name: '../x' } } } }), refused);
  // Only the fixed checks delete or rename, and only CONTEXT.md and .scratch/.
  for (const edit of [{ kind: 'delete' }, { kind: 'rename', to: 'GLOSSARY.md' }]) {
    const clash = { id: 'x', file: '.github/workflows/ci.yml', reason: 'Injected.', ticked: true, edit };
    assert.deepEqual(await open({ repo: 'maddec01/lar-web', edits: guidance, picks: { clashes: [clash], skills: {} } }), refused);
  }
});

const AZURE = 'contoso/Fabrikam%20Fiber/lar-api';

test('Azure onboarding previews and commits provider-specific agent guidance from the repository provider', async () => {
  const az = fakeAzRepos({ files: { '/AGENTS.md': RULES } });
  const preview = await previewOnboardingPr({ repo: AZURE, edits: guidance }, az.run);
  assert.ok('changes' in preview);
  await createPrOpener(az.run)({ repo: AZURE, edits: guidance });
  const content = (path: string) => az.pushes[0]!.changes.find((change) => change.path === path)!.content!;
  const tracker = content('/docs/agents/issue-tracker.md');
  assert.match(tracker, /Azure Boards work items/);
  assert.match(content('/docs/agents/triage-labels.md'), /no factory tags/);
  assert.match(content('/AGENTS.md'), /Azure Boards work items/);
  for (const path of ['/AGENTS.md', '/docs/agents/issue-tracker.md', '/docs/agents/triage-labels.md', '/docs/agents/domain.md']) {
    assert.doesNotMatch(content(path), /GitHub|\bgh |[–—‘’“”]/);
    assert.equal(preview.changes.find((change) => `/${change.path}` === path)?.preview?.after, content(path));
  }
  assert.ok(az.calls.filter((args) => args[1] === 'invoke').every((args) => args.includes('--api-version')));
  assert.match(az.calls.flat().find((arg) => arg.startsWith('--description='))!, /approved before it opened this PR/);
});

test('the preview shows current and proposed contents of each file it writes', async () => {
  const oldDomain = '# Domain\n\nUse the billing glossary.\n';
  const az = fakeAzRepos({ files: { '/AGENTS.md': RULES, '/docs/agents/domain.md': oldDomain } });
  const result = await previewOnboardingPr({ repo: AZURE, edits: { drop: [], guidance: true, config: { itemSource: { kind: 'azure-board', team: 'Fabrikam Team' } } } }, az.run);
  assert.ok('changes' in result);
  for (const [path, before] of [['AGENTS.md', RULES], ['docs/agents/domain.md', oldDomain], ['.lar-factory.json', null]]) {
    const change: OnboardingPrChange | undefined = result.changes.find((candidate) => candidate.path === path);
    assert.ok(change?.preview, `${path} has a content preview`);
    assert.equal(change.preview.before, before);
    assert.ok(change.preview.after.length > 0);
  }
  assert.equal(az.pushes.length, 0);
  assert.equal(az.prs.length, 0);
});

const AZURE_PR = `${REPO_URL}/pullrequest/100`;

test('on Azure Repos, one push makes the commit on lar-factory/onboarding, then az opens the PR, with no gh call', async () => {
  const az = fakeAzRepos({ files: { '/AGENTS.md': '# lar-web\n\n## Agent skills\n\nOld.\n', '/.lar-factory.json': '{}' } });
  const opened = await createPrOpener(az.run)({ repo: AZURE, edits: { drop: ['config', 'agent-skills'] } });
  assert.equal((opened as { prUrl: string }).prUrl, AZURE_PR);
  const [push] = az.pushes;
  assert.deepEqual([push!.ref, push!.oldObjectId, push!.parents, push!.comment],
    ['refs/heads/lar-factory/onboarding', '0'.repeat(40), ['abc123'], 'chore: update Lar Factory files']);
  assert.deepEqual(push!.changes.map((c) => [c.changeType, c.path]).sort(), [['delete', '/.lar-factory.json'], ['edit', '/AGENTS.md']]);
  const create = az.calls.find((args) => args.slice(0, 3).join(' ') === 'repos pr create')!;
  assert.deepEqual([create[create.indexOf('--source-branch') + 1], create[create.indexOf('--target-branch') + 1]], ['lar-factory/onboarding', 'main']);
  // The title and description go joined to their flags, so one starting with - is no option.
  assert.ok(create.includes('--title=chore: update Lar Factory files') && !create.includes('--title'), create.join(' '));
  assert.ok(az.calls.every((args) => args[0] === 'devops' || args[0] === 'repos'), 'every call is az devops or az repos');
});

test("on Azure Repos, a failed push answers with az's message, and Retry goes on from the call that failed", async () => {
  for (const [failing, retried] of [['pushes', ['repos ref list', 'repos ref list', 'invoke git/commits', 'invoke git/trees', 'invoke git/pushes', 'repos pr create']],
    ['repos pr create', ['repos pr create']]] as const) {
    let fails = true;
    const message = `az ${failing} failed: TF401027: You need the Git 'GenericContribute' permission.`;
    const az = fakeAzRepos({ files: { '/AGENTS.md': RULES }, fail: (args) => (fails && args.join(' ').includes(failing) ? new Error(message) : undefined) });
    const open = createPrOpener(az.run);
    assert.deepEqual(await open({ repo: AZURE, edits: guidance }), { status: 502, error: `Can't open ${AZURE}'s onboarding PR: ${message}` });
    fails = false;
    az.calls.length = 0;
    assert.equal((await open({ repo: AZURE, edits: guidance }) as { prUrl: string }).prUrl, AZURE_PR);
    assert.deepEqual(az.calls.map((args) => (args[0] === 'devops' ? `invoke ${args[args.indexOf('--area') + 1]}/${args[args.indexOf('--resource') + 1]}` : args.slice(0, 3).join(' '))), retried);
    assert.equal(az.pushes.length, 1);
  }
});

test("onboarding's PR never carries Connections, even when the body sends them", async () => {
  const preview = await previewOnboardingPr({ repo: 'maddec01/lar-web', connections: ['maddec01/lar-api'],
    edits: { drop: [], config: { ...config, connections: [['maddec01/lar-api', 'maddec01/lar-web']] }, guidance: true }, picks }, gh().run);
  assert.ok('changes' in preview);
  assert.ok(preview.changes.some((c) => c.path === '.lar-factory.json'));
  assert.ok(preview.changes.every((c) => !JSON.stringify(c).includes('lar-api')), JSON.stringify(preview.changes));
});
