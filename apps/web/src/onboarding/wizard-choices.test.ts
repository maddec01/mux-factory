// The onboarding wizard's questions: the steps a run shows, each answer's detected default and where it came from,
// Refused on options access blocks, and the lines each step says about the choices it leaves for later.

import { expect, test } from 'vite-plus/test';
import type { SetupDetection } from '@lar-factory/shared';
import { detection } from './onboarding-support.ts';
import { answerProblem, answersOf, consentOptions, defaultsOf, docsOptions, fileOptions, laterLines, originOf, sourceOptions, stepsOf } from './wizard-choices.ts';

const azure = (parts: Partial<SetupDetection> = {}) => detection({ repo: 'contoso/Fabrikam/lar-api', provider: 'Azure DevOps',
  itemSources: { found: [{ kind: 'azure-board', team: 'Fabrikam Team' }, { kind: 'azure-board', team: 'Web' }] }, ...parts });

const contributor = { 'push-branch': 'refused', 'open-pr': 'unverified', 'publish-ticket': 'allowed', 'edit-ticket': 'unverified', 'tag-ticket': 'refused', 'comment-ticket': 'unverified', 'type-ticket': 'unverified', 'relate-ticket': 'unverified' } as const;

test('a GitHub repository with no factory files asks its questions in order after detection', () => {
  expect(stepsOf('GitHub', detection(), {})).toEqual(['project', 'detect', 'import', 'role', 'connections', 'consent', 'docs', 'skills']);
});

test('an Azure DevOps repository picks its team before the import, and earlier factory files add Factory files, then Repository edits once one is dropped', () => {
  const files = azure({ factoryFiles: { found: [{ kind: 'config', paths: ['.lar-factory.json'] }] } });
  expect(stepsOf('Azure DevOps', null, {})).toEqual(['project', 'detect', 'source', 'import', 'role', 'connections', 'consent', 'docs', 'skills']);
  expect(stepsOf('Azure DevOps', files, {})).toEqual(['project', 'detect', 'source', 'import', 'role', 'connections', 'consent', 'docs', 'skills', 'files']);
  expect(stepsOf('Azure DevOps', files, { drop: ['config'] }).slice(-2)).toEqual(['files', 'edits']);
});

test('the defaults come from detection: issues, every allowed write a current feature uses, private drafts with no docs, and no project skill', () => {
  expect(defaultsOf(detection({ access: contributor, projectSkills: { found: ['tdd', 'web-style'] } }))).toEqual({
    itemSource: { kind: 'issues' }, role: '', consent: [], domainDocs: { kind: 'private' }, skills: [], drop: [],
  });
  expect(defaultsOf(detection()).consent, 'publishing waits for a later build').toEqual(['push-branch', 'open-pr', 'edit-ticket']);
  const selected = detection({ projectSkills: { found: ['tdd', 'web-style'] }, sharedConfig: { found: { defaults: { skills: ['tdd'] } } } });
  expect(defaultsOf(selected).skills, 'only the skills the shared Repository config selects start ticked').toEqual(['tdd']);
  expect(defaultsOf(detection({ domainDocs: { found: { kind: 'repository', glossary: 'CONTEXT.md', adrs: 'docs/adr' } } })).domainDocs)
    .toEqual({ kind: 'repository', glossary: 'CONTEXT.md', adrs: 'docs/adr' });
});

test("a shared .lar-factory.json's defaults come before detection's, and say so until the user changes one", () => {
  const shared = azure({ sharedConfig: { found: { defaults: { role: 'API server', itemSource: { kind: 'azure-board', team: 'Web' }, skills: ['dotnet-style'] } } } });
  expect(defaultsOf(shared)).toMatchObject({ role: 'API server', itemSource: { kind: 'azure-board', team: 'Web' }, skills: ['dotnet-style'] });
  expect(defaultsOf(azure()).itemSource, 'with no shared team, the first team').toEqual({ kind: 'azure-board', team: 'Fabrikam Team' });
  expect(originOf(shared, {}, 'role')).toBe('shared');
  expect(originOf(shared, { role: 'API server' }, 'role'), 'a choice equal to the default').toBe('shared');
  expect(originOf(shared, { role: 'Payments API' }, 'role')).toBe('changed');
  expect(originOf(shared, {}, 'consent')).toBe('detected');
});

test("a shared team the login can't list is still offered, first", () => {
  const shared = azure({ itemSources: { refused: "Can't read Fabrikam's teams with az: denied" },
    sharedConfig: { found: { defaults: { itemSource: { kind: 'azure-board', team: 'Web' } } } } });
  expect(sourceOptions(shared).map((o) => o.title)).toEqual(['Web']);
  expect(sourceOptions(azure()).map((o) => o.title)).toEqual(['Fabrikam Team', 'Web']);
  expect(answerProblem('source', answersOf(azure({ itemSources: { refused: 'denied' } }), {}))).toBe('Choose a team to continue.');
});

test('writes the login refuses are Refused, cannot be consented to, and unverified ones say so; publishing writes are no option yet', () => {
  const options = consentOptions(detection({ access: contributor }));
  expect(options.map((o) => [o.title, o.refused, o.unverified])).toEqual([
    ['Push branches', true, false], ['Open pull requests', false, true], ['Edit issues', false, true],
  ]);
  expect(answersOf(detection(), { consent: ['publish-ticket', 'open-pr', 'tag-ticket'] }).consent).toEqual(['open-pr']);
  expect(options[0]!.cost).toBe("Refused: your GitHub access doesn't allow it.");
  expect(options[1]!.cost).toBe('How builds deliver. Off: builds stop at a pushed branch.');
  expect(answersOf(detection({ access: contributor }), { consent: ['push-branch', 'open-pr'] }).consent).toEqual(['open-pr']);
  expect(consentOptions(azure()).map((o) => o.title).slice(2)).toEqual(['Edit work items']);
});

test("repository domain docs are Refused when the files can't be read or the login can't open the build PR, and the default falls back to private drafts", () => {
  const existing = { found: { kind: 'repository' as const, glossary: 'GLOSSARY.md', adrs: 'docs/adr' } };
  expect(docsOptions(detection({ domainDocs: existing })).map((o) => [o.title, o.refused])).toEqual([['Use GLOSSARY.md and docs/adr/', false], ['Keep private drafts', undefined]]);
  expect(docsOptions(detection()).map((o) => o.title)[0]).toBe('Start GLOSSARY.md and docs/adr/ in the repository');
  const blocked = detection({ domainDocs: existing, access: { ...detection().access, 'open-pr': 'refused' } });
  expect(docsOptions(blocked)[0]).toMatchObject({ refused: true, cost: "Refused: your access can't open the build PRs that write them." });
  expect(defaultsOf(blocked).domainDocs).toEqual({ kind: 'private' });
  expect(docsOptions(detection({ domainDocs: { refused: 'denied' } }))[0]).toMatchObject({ refused: true, cost: "Refused: the repository's files can't be read." });
});

test("dropping a factory file is Refused when the login can't push or open the PR, and a refused drop is never kept", () => {
  const files = { found: [{ kind: 'agent-skills' as const, paths: ['AGENTS.md'] }, { kind: 'agent-docs' as const, paths: ['docs/agents/domain.md'] }] };
  expect(fileOptions(detection({ factoryFiles: files })).map((o) => [o.title, o.refused])).toEqual([['## Agent skills in AGENTS.md', false], ['docs/agents/domain.md', false]]);
  const blocked = detection({ factoryFiles: files, access: contributor });
  expect(fileOptions(blocked)[0]!.cost).toBe("Refused: your access can't open the PR that drops it.");
  expect(answersOf(blocked, { drop: ['agent-skills'] }).drop).toEqual([]);
  expect(answersOf(detection({ factoryFiles: files }), { drop: ['agent-skills', 'config'] }).drop, 'a kind the repository lacks').toEqual(['agent-skills']);
});

test('the role step waits for a role', () => {
  expect(answerProblem('role', answersOf(detection(), {}))).toBe('Describe what this repository does to continue.');
  expect(answerProblem('role', answersOf(detection(), { role: 'Web client' }))).toBeNull();
});

test('each related step names the choices it leaves for later in one line each', () => {
  expect(laterLines('detect', detection())).toEqual([
    "You'll be offered a shared Repository config when a setting is worth sharing with your team.",
    'Labels and agent guidance for the repository are offered when a feature would use them.',
  ]);
  expect(laterLines('detect', azure({ sharedConfig: { found: { defaults: {} } } })), 'no config offer where one exists')
    .toEqual(['Tags and agent guidance for the repository are offered when a feature would use them.']);
  expect(laterLines('detect', detection({ sharedConfig: { refused: 'denied' } })), "no config offer where it can't be read").toHaveLength(1);
  expect(laterLines('consent', detection())).toEqual(["You'll choose whether the factory may open and label issues, map its kinds to your labels and choose how to publish the first time you publish refined work."]);
  expect(laterLines('consent', azure())[0]).toContain('create and tag work items, map its kinds to your work item types and tags');
  expect(laterLines('docs', detection())).toEqual(["You'll choose whether to publish private drafts when a build first writes them."]);
  expect(laterLines('skills', detection())).toEqual(["If a project rule blocks factory work, you'll choose how to resolve it then."]);
  for (const step of ['project', 'source', 'import', 'role', 'files', 'edits'] as const) expect(laterLines(step, detection()), step).toEqual([]);
});
