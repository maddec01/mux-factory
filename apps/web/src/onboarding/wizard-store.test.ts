// The onboarding run: the T3 projects it offers, picking one, detecting its setup, the steps it moves through, the
// tickets it imports, saving its answers and opening the approved PR, and keeping it on the board when the dialog
// closes, to resume.

import { expect, test } from 'vite-plus/test';
import { fetchMock, sample, settle } from '../../test/support.ts';
import type { ImportableTicket, OnboardingProgress, ProjectChoice, SetupDetection } from '@lar-factory/shared';
import { detection, posted, project, serve, type Route } from './onboarding-support.ts';

const PROJECTS = [project('lar-web'), project('lar-server', { onBoard: true }), project('notes', { repo: null, provider: null, hasConfig: null })];

const ticket = (number: number, parts: Partial<ImportableTicket> = {}): ImportableTicket => ({
  number, title: `Ticket ${number}`, url: `https://github.com/maddec01/lar-web/issues/${number}`, statuses: ['Ready'], untagged: false, workId: null, ...parts,
});

/** The calls an onboarding run makes, answered as a repository with no factory files and no tickets would. */
const ROUTES = (found: SetupDetection = detection(), tickets: ImportableTicket[] = []): Record<string, Route> => ({
  '/api/onboarding/detect': { detection: found, error: null },
  '/api/onboarding/import/tickets': { tickets, error: null },
  '/api/onboarding/setup': { error: null },
});

/** The store, fresh, with T3's projects `projects` and the onboarding calls answered by `routes`. */
async function store(projects: ProjectChoice[] | { error: string } = PROJECTS, routes: Record<string, Route> = ROUTES()) {
  serve(sample, projects, { error: null }, 200, routes);
  const { useWizardStore } = await import('./wizard-store.ts');
  return useWizardStore;
}

type Wizard = Awaited<ReturnType<typeof store>>;

/** Whether Next or Finish can move past the run's step. */
async function ready(wizard: Wizard) {
  const { stepReady } = await import('./wizard-store.ts');
  const { run, projects, detection: found, tickets, changes, approved } = wizard.getState();
  return stepReady(run!, projects, found, tickets, changes, approved);
}

/** Starts a run, picks lar-web, and moves on to What we found. */
async function detected(routes = ROUTES(), projects = PROJECTS) {
  const wizard = await store(projects, routes);
  await settle(() => wizard.getState().start());
  wizard.getState().pick('lar-web');
  await settle(() => wizard.getState().next());
  return wizard;
}

/** Presses Next until the run reaches `step`. */
async function nextTo(wizard: Wizard, step: string) {
  for (let i = 0; i < 10 && wizard.getState().run!.step !== step; i++) await settle(() => wizard.getState().next());
  expect(wizard.getState().run!.step).toBe(step);
}

test("starting a run opens it on the T3 project step and reads T3's projects", async () => {
  const wizard = await store();
  await settle(() => wizard.getState().start());
  expect(wizard.getState().run).toEqual({ step: 'project', projectId: null, repo: null, provider: null, savedAs: null, choices: {} });
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/onboarding/projects']);
  expect(wizard.getState().projects).toEqual({ state: 'loaded', projects: PROJECTS });
});

test('starting a run from an offer opens it with the offered project picked', async () => {
  const wizard = await store([project('lar-web', { hasConfig: true })]);
  await settle(() => wizard.getState().start({ projectId: 'lar-web', name: 'lar-web', repo: 'maddec01/lar-web', provider: 'GitHub' }));
  expect(wizard.getState().run).toEqual({ step: 'project', projectId: 'lar-web', repo: 'maddec01/lar-web', provider: 'GitHub', savedAs: null, choices: {} });
  expect(await ready(wizard)).toBe(true);
});

test('closing an offered run untouched keeps nothing; once Next moves it or a change, closing keeps it', async () => {
  const wizard = await store([project('lar-web', { hasConfig: true }), project('lar-cli')]);
  const offer = { projectId: 'lar-web', name: 'lar-web', repo: 'maddec01/lar-web', provider: 'GitHub' as const };
  await settle(() => wizard.getState().start(offer));
  await settle(() => wizard.getState().close());
  expect(posted('/api/onboarding/repositories'), 'nothing kept').toEqual([]);
  await settle(() => wizard.getState().start(offer));
  await settle(() => wizard.getState().next());
  await settle(() => wizard.getState().close());
  await settle(() => wizard.getState().start(offer));
  wizard.getState().pick('lar-cli');
  await settle(() => wizard.getState().close());
  expect(posted('/api/onboarding/repositories').map((body) => body.repo)).toEqual(['maddec01/lar-web', 'maddec01/lar-cli']);
});

test("a project read that fails keeps the server's problem, and Retry reads again", async () => {
  const wizard = await store({ error: "Can't read T3 Code's projects at /x" });
  await settle(() => wizard.getState().start());
  expect(wizard.getState().projects).toEqual({ state: 'failed', error: "Can't read T3 Code's projects at /x" });
  serve(sample, PROJECTS);
  await settle(() => wizard.getState().loadProjects());
  expect(wizard.getState().projects.state).toBe('loaded');
});

test('Next waits for a project that can be picked, then detects its setup on What we found; Back returns', async () => {
  const wizard = await store();
  await settle(() => wizard.getState().start());
  expect(await ready(wizard)).toBe(false);
  for (const taken of ['lar-server', 'notes']) {
    wizard.getState().pick(taken);
    expect(wizard.getState().run!.projectId, `${taken} can't be picked`).toBeNull();
  }
  wizard.getState().pick('lar-web');
  expect(await ready(wizard)).toBe(true);
  await settle(() => wizard.getState().next());
  expect(wizard.getState().run!.step).toBe('detect');
  expect(posted('/api/onboarding/detect')).toEqual([{ repo: 'maddec01/lar-web', projectId: 'lar-web' }]);
  expect(wizard.getState().detection).toEqual({ state: 'read', value: detection() });
  expect(await ready(wizard)).toBe(true);
  wizard.getState().back();
  expect(wizard.getState().run!.step).toBe('project');
});

test("What we found holds Next while it reads, when it can't, and when agents can't work in the folder; Retry detects again", async () => {
  const wizard = await detected({ ...ROUTES(), '/api/onboarding/detect': { error: "Can't read maddec01/lar-web with gh: HTTP 404" } });
  expect(wizard.getState().detection).toEqual({ state: 'failed', error: "Can't read maddec01/lar-web with gh: HTTP 404" });
  expect(await ready(wizard)).toBe(false);
  serve(sample, PROJECTS, { error: null }, 200, ROUTES(detection({ checkout: { refused: 'More than one T3 project points to maddec01/lar-web.' } })));
  await settle(() => wizard.getState().detect());
  expect(await ready(wizard)).toBe(false);
  serve(sample, PROJECTS, { error: null }, 200, ROUTES());
  await settle(() => wizard.getState().detect());
  expect(await ready(wizard)).toBe(true);
});

test('a project whose repository is onboarding already says to use its Resume', async () => {
  const { unpickable } = await import('./wizard-store.ts');
  const run = { step: 'project' as const, projectId: null, repo: null, provider: null, savedAs: null, choices: {} };
  const data = { onboarding: [{ repo: 'maddec01/lar-server', progress: { step: 'role', done: ['project'], answers: { projectId: 'lar-server' } } }] };
  expect(unpickable(project('lar-server', { onBoard: true }), run, data)).toBe('Setup is already in progress. Close this window and choose Resume.');
  expect(unpickable(project('lar-server', { onBoard: true }), run, { onboarding: [] })).toBe('This repository is already on the board.');
});

test('closing before a project is picked drops the run and keeps nothing', async () => {
  const wizard = await store();
  await settle(() => wizard.getState().start());
  await settle(() => wizard.getState().close());
  expect(wizard.getState().run).toBeNull();
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/onboarding/projects']);
});

test('closing once a project is picked keeps the repository as onboarding, with its step, the steps before it and the changed choices', async () => {
  const wizard = await detected();
  await nextTo(wizard, 'role');
  wizard.getState().choose({ role: 'Web client' });
  await settle(() => wizard.getState().close());
  expect(wizard.getState().run).toBeNull();
  expect(posted('/api/onboarding/repositories')).toEqual([{ repo: 'maddec01/lar-web',
    progress: { step: 'role', done: ['project', 'detect', 'import'], answers: { projectId: 'lar-web', provider: 'GitHub', choices: { role: 'Web client' } } } }]);
});

const kept = (step: string, choices = {}): OnboardingProgress => ({ step, done: ['project'], answers: { projectId: 'lar-web', provider: 'GitHub', choices } });

test('Resume reopens the run on its step with its choices, detects again, and its own project can be picked again', async () => {
  const wizard = await store([project('lar-web', { onBoard: true }), project('lar-apple')]);
  const { useBoardStore } = await import('../board/board-store.ts');
  useBoardStore.getState().receive({ ...sample, onboarding: [{ repo: 'maddec01/lar-web', progress: kept('role', { role: 'Web client' }) }] });
  await settle(() => wizard.getState().resume('maddec01/lar-web'));
  expect(wizard.getState().run).toEqual({ step: 'role', projectId: 'lar-web', repo: 'maddec01/lar-web', provider: 'GitHub', savedAs: 'maddec01/lar-web', choices: { role: 'Web client' } });
  expect(wizard.getState().detection?.state).toBe('read');
  expect(await ready(wizard)).toBe(true);
  wizard.getState().pick('lar-apple');
  wizard.getState().pick('lar-web');
  expect(wizard.getState().run).toMatchObject({ projectId: 'lar-web', choices: {} });
});

test('Resume on Work to import reads the tickets once it has detected the item source', async () => {
  const wizard = await store(PROJECTS, ROUTES(detection(), [ticket(3)]));
  const { useBoardStore } = await import('../board/board-store.ts');
  useBoardStore.getState().receive({ ...sample, onboarding: [{ repo: 'maddec01/lar-web', progress: kept('import') }] });
  await settle(() => wizard.getState().resume('maddec01/lar-web'));
  expect(posted('/api/onboarding/import/tickets')).toEqual([{ repo: 'maddec01/lar-web', itemSource: { kind: 'issues' } }]);
});

test('a resumed run that picks another project replaces the onboarding it was kept under', async () => {
  const wizard = await store([project('lar-web', { onBoard: true }), project('lar-apple')]);
  const { useBoardStore } = await import('../board/board-store.ts');
  useBoardStore.getState().receive({ ...sample, onboarding: [{ repo: 'maddec01/lar-web', progress: kept('project') }] });
  await settle(() => wizard.getState().resume('maddec01/lar-web'));
  wizard.getState().pick('lar-apple');
  await settle(() => wizard.getState().close());
  expect(posted('/api/onboarding/repositories')).toEqual([{ repo: 'maddec01/lar-apple', replaces: 'maddec01/lar-web',
    progress: { step: 'project', done: [], answers: { projectId: 'lar-apple', provider: 'GitHub' } } }]);
});

test("a stored step the dialog doesn't have, as an older board's, resumes on the T3 project step", async () => {
  const wizard = await store();
  const { useBoardStore } = await import('../board/board-store.ts');
  useBoardStore.getState().receive({ ...sample, onboarding: [{ repo: 'maddec01/lar-web', progress: kept('labels') }] });
  await settle(() => wizard.getState().resume('maddec01/lar-web'));
  expect(wizard.getState().run).toMatchObject({ step: 'project', projectId: 'lar-web' });
});

test('a project read that answers after the run closed changes nothing', async () => {
  let answer: (r: Response) => void = () => {};
  fetchMock.mockImplementation(() => new Promise<Response>((resolve) => { answer = resolve; }));
  const { useWizardStore: wizard } = await import('./wizard-store.ts');
  wizard.getState().start();
  wizard.getState().close();
  await settle(() => answer(new Response(JSON.stringify({ projects: PROJECTS }))));
  expect(wizard.getState().projects).toEqual({ state: 'loading' });
});

/** The store, fresh, whose project reads answer PROJECTS and whose project creation answers `created`. */
async function creatingStore(created: () => Response) {
  const wizard = await store();
  serve(sample, PROJECTS, { error: null }, 200, { '/api/onboarding/projects': (body) => (body.folder ? created() : { projects: PROJECTS }) });
  fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ projects: PROJECTS })));
  await settle(() => wizard.getState().start());
  return wizard;
}

const added = project('lar-apple', { folder: '/Users/me/Developer/lar-apple' });

test('Add a folder to T3 Code adds the folder, then picks the new project', async () => {
  const wizard = await creatingStore(() => new Response(JSON.stringify({ projects: [...PROJECTS, added], projectId: 'lar-apple', error: null })));
  wizard.getState().pick('lar-web');
  wizard.getState().chooseNew();
  expect(wizard.getState().run).toMatchObject({ projectId: null, repo: null });
  wizard.getState().setFolder('~/Developer/lar-apple');
  await settle(() => wizard.getState().createProject());
  expect(posted('/api/onboarding/projects').at(-1)).toEqual({ folder: '~/Developer/lar-apple' });
  expect(wizard.getState().projects).toEqual({ state: 'loaded', projects: [...PROJECTS, added] });
  expect(wizard.getState().run).toMatchObject({ projectId: 'lar-apple', repo: 'maddec01/lar-apple' });
  expect(wizard.getState().creating).toBeNull();
});

test('a failing t3 project add keeps the folder on the step with its message', async () => {
  const wizard = await creatingStore(() => new Response(JSON.stringify({ error: 't3 could not add the project: Could not reach the T3 Code server.' }), { status: 502 }));
  wizard.getState().chooseNew();
  wizard.getState().setFolder('~/Developer/lar-apple');
  await settle(() => wizard.getState().createProject());
  expect(wizard.getState().creating).toEqual({ folder: '~/Developer/lar-apple', adding: false, error: 't3 could not add the project: Could not reach the T3 Code server.' });
  expect(wizard.getState().run).toMatchObject({ step: 'project', projectId: null });
});

test("a new project that can't be picked stays on the form with the reason", async () => {
  const bare = project('notes-2', { repo: null, provider: null, hasConfig: null });
  const wizard = await creatingStore(() => new Response(JSON.stringify({ projects: [...PROJECTS, bare], projectId: 'notes-2', error: null })));
  wizard.getState().chooseNew();
  wizard.getState().setFolder('/Users/me/notes-2');
  await settle(() => wizard.getState().createProject());
  expect(wizard.getState().run).toMatchObject({ projectId: null });
  expect(wizard.getState().creating).toEqual({ folder: '/Users/me/notes-2', adding: false,
    error: 'T3 Code added the project, but it can\'t be picked: Choose a repository folder connected to GitHub or Azure DevOps.' });
});

test('a repository with no factory files goes through every question, and Finish saves the detected defaults with the role, writing nothing to it', async () => {
  const wizard = await detected(ROUTES(detection({ projectSkills: { found: ['tdd'] } })));
  const steps = ['detect'];
  for (let i = 0; i < 8 && !(await ready(wizard) && wizard.getState().run!.step === 'skills'); i++) {
    if (wizard.getState().run!.step === 'role') wizard.getState().choose({ role: '  Web client ' });
    await settle(() => wizard.getState().next());
    steps.push(wizard.getState().run!.step);
  }
  expect(steps).toEqual(['detect', 'import', 'role', 'connections', 'consent', 'docs', 'skills']);
  await settle(() => wizard.getState().save());
  expect(posted('/api/onboarding/setup')).toEqual([{ repo: 'maddec01/lar-web', projectId: 'lar-web', itemSource: { kind: 'issues' }, role: '  Web client ',
    consent: ['push-branch', 'open-pr', 'edit-ticket'], domainDocs: { kind: 'private' }, skills: [], connections: [] }]);
  expect(posted('/api/onboarding/pr')).toEqual([]);
  expect(wizard.getState().finish).toEqual({ state: 'done', pr: null });
  await settle(() => wizard.getState().close());
  expect(posted('/api/onboarding/repositories'), 'a saved run keeps no onboarding').toEqual([]);
});

test('the role step holds Next until it has a role, and Finish waits for the last step', async () => {
  const wizard = await detected();
  await nextTo(wizard, 'role');
  expect(await ready(wizard)).toBe(false);
  await settle(() => wizard.getState().save());
  expect(posted('/api/onboarding/setup'), 'Finish only on the last step').toEqual([]);
  wizard.getState().choose({ role: 'Web client' });
  expect(await ready(wizard)).toBe(true);
});

test("a save the board refuses keeps the last step with the board's problem, and Finish again saves", async () => {
  const wizard = await detected({ ...ROUTES(), '/api/onboarding/setup': { error: 'maddec01/lar-web is onboarded already.' } });
  await nextTo(wizard, 'role');
  wizard.getState().choose({ role: 'Web client' });
  await nextTo(wizard, 'skills');
  await settle(() => wizard.getState().save());
  expect(wizard.getState().finish).toEqual({ state: 'failed', error: 'maddec01/lar-web is onboarded already.' });
  expect(wizard.getState().run!.step).toBe('skills');
});

const azure = detection({ repo: 'contoso/Fabrikam/lar-api', provider: 'Azure DevOps',
  itemSources: { found: [{ kind: 'azure-board', team: 'Fabrikam Team' }, { kind: 'azure-board', team: 'Web' }] } });

test("an Azure DevOps run picks its team before the import, and a new team reads that team's tickets", async () => {
  const projects = [project('lar-api', { repo: 'contoso/Fabrikam/lar-api', provider: 'Azure DevOps' })];
  const wizard = await store(projects, ROUTES(azure));
  await settle(() => wizard.getState().start());
  wizard.getState().pick('lar-api');
  await settle(() => wizard.getState().next());
  await settle(() => wizard.getState().next());
  expect(wizard.getState().run!.step).toBe('source');
  wizard.getState().choose({ itemSource: { kind: 'azure-board', team: 'Web' } });
  await settle(() => wizard.getState().next());
  expect(wizard.getState().run!.step).toBe('import');
  expect(posted('/api/onboarding/import/tickets')).toEqual([{ repo: 'contoso/Fabrikam/lar-api', itemSource: { kind: 'azure-board', team: 'Web' } }]);
});

test('Work to import ticks each ticket not recorded yet, and Next imports the ticked ones with what each needs settled', async () => {
  const tickets = [ticket(3), ticket(4, { statuses: ['Ready', 'In progress'] }), ticket(5), ticket(6, { workId: 'W-2' })];
  const imported: Route = (body) => ({ imported: (body.tickets as { number: number }[]).map(({ number }) => ({ number, workId: `W-${number}`, created: true, threads: 0 })), refused: [], error: null });
  const wizard = await detected({ ...ROUTES(detection(), tickets), '/api/onboarding/import': imported });
  await settle(() => wizard.getState().next());
  expect(wizard.getState().tickets!.picks).toEqual({ 3: { on: true }, 4: { on: true }, 5: { on: true } });
  expect(await ready(wizard), "#4's Status isn't chosen").toBe(false);
  wizard.getState().pickTicket(4, { status: 'In progress' });
  wizard.getState().pickTicket(5, { on: false });
  expect(await ready(wizard)).toBe(true);
  await settle(() => wizard.getState().next());
  expect(posted('/api/onboarding/import')).toEqual([{ repo: 'maddec01/lar-web', itemSource: { kind: 'issues' }, tickets: [{ number: 3 }, { number: 4, status: 'In progress' }] }]);
  expect(posted('/api/onboarding/import/tickets'), 'the list is read again for the new records').toHaveLength(2);
  expect(wizard.getState().run!.step).toBe('role');
});

test("an untagged Azure DevOps work item holds Next until it's confirmed as this repository's, then imports with placeHere", async () => {
  const projects = [project('lar-api', { repo: 'contoso/Fabrikam/lar-api', provider: 'Azure DevOps' })];
  const wizard = await store(projects, { ...ROUTES(azure, [ticket(7, { untagged: true })]),
    '/api/onboarding/import': { imported: [{ number: 7, workId: 'W-7', created: true, threads: 1 }], refused: [], error: null } });
  await settle(() => wizard.getState().start());
  wizard.getState().pick('lar-api');
  await nextTo(wizard, 'import');
  expect(await ready(wizard)).toBe(false);
  wizard.getState().pickTicket(7, { placeHere: true });
  await settle(() => wizard.getState().next());
  expect(posted('/api/onboarding/import')[0]!.tickets).toEqual([{ number: 7, placeHere: true }]);
});

test('a ticket the import refuses keeps the step with its reason, until the user changes its pick', async () => {
  const wizard = await detected({ ...ROUTES(detection(), [ticket(3), ticket(8)]),
    '/api/onboarding/import': { imported: [{ number: 3, workId: 'W-3', created: true, threads: 0 }], refused: [{ number: 8, reason: 'maddec01/lar-web#8 is no longer open.' }], error: null } });
  await nextTo(wizard, 'import');
  await settle(() => wizard.getState().next());
  expect(wizard.getState().run!.step).toBe('import');
  expect(wizard.getState().tickets!.refused).toEqual({ 8: 'maddec01/lar-web#8 is no longer open.' });
  wizard.getState().pickTicket(8, { on: false });
  expect(wizard.getState().tickets!.refused).toEqual({});
});

test("tickets the board can't read let Next go on without importing", async () => {
  const wizard = await detected({ ...ROUTES(), '/api/onboarding/import/tickets': { error: "Can't read maddec01/lar-web's tickets." } });
  await nextTo(wizard, 'import');
  expect(wizard.getState().tickets!.read).toEqual({ state: 'failed', error: "Can't read maddec01/lar-web's tickets." });
  await settle(() => wizard.getState().next());
  expect(wizard.getState().run!.step).toBe('role');
  expect(posted('/api/onboarding/import')).toEqual([]);
});

const withFiles = detection({ factoryFiles: { found: [{ kind: 'config', paths: ['.lar-factory.json'] }, { kind: 'agent-skills', paths: ['AGENTS.md'] }] },
  sharedConfig: { found: { defaults: { role: 'Web client' } } } });
const CHANGES = [{ kind: 'agent-skills' as const, path: 'AGENTS.md', removed: true as const }];

test('a dropped factory file adds Repository edits, which previews the PR, and Finish waits for approval, saves, then opens the PR', async () => {
  const wizard = await detected({ ...ROUTES(withFiles), '/api/onboarding/pr/changes': { changes: CHANGES, error: null },
    '/api/onboarding/pr': { prUrl: 'https://github.com/maddec01/lar-web/pull/9', error: null } });
  await nextTo(wizard, 'files');
  expect(await ready(wizard), 'keeping every file finishes here').toBe(true);
  wizard.getState().choose({ drop: ['agent-skills'] });
  await nextTo(wizard, 'edits');
  expect(posted('/api/onboarding/pr/changes')).toEqual([{ repo: 'maddec01/lar-web', edits: { drop: ['agent-skills'] } }]);
  expect(wizard.getState().changes).toEqual({ state: 'read', value: CHANGES });
  expect(await ready(wizard)).toBe(false);
  wizard.getState().approve(true);
  await settle(() => wizard.getState().save());
  expect(posted('/api/onboarding/setup')).toHaveLength(1);
  expect(posted('/api/onboarding/pr')).toEqual([{ repo: 'maddec01/lar-web', edits: { drop: ['agent-skills'] } }]);
  expect(wizard.getState().finish).toEqual({ state: 'done', pr: { state: 'opened', url: 'https://github.com/maddec01/lar-web/pull/9' } });
});

test("a PR the board can't open leaves the repository saved, with gh's message and Retry", async () => {
  const wizard = await detected({ ...ROUTES(withFiles), '/api/onboarding/pr/changes': { changes: CHANGES, error: null },
    '/api/onboarding/pr': { error: "Can't open maddec01/lar-web's onboarding PR: HTTP 403" } });
  await nextTo(wizard, 'files');
  wizard.getState().choose({ drop: ['agent-skills'] });
  await nextTo(wizard, 'edits');
  wizard.getState().approve(true);
  await settle(() => wizard.getState().save());
  expect(wizard.getState().finish).toEqual({ state: 'done', pr: { state: 'failed', error: "Can't open maddec01/lar-web's onboarding PR: HTTP 403" } });
  serve(sample, PROJECTS, { error: null }, 200, { '/api/onboarding/pr': { prUrl: 'https://github.com/maddec01/lar-web/pull/9', error: null } });
  await settle(() => wizard.getState().openPr());
  expect(wizard.getState().finish).toMatchObject({ pr: { state: 'opened' } });
});

test('keeping the file again drops Repository edits and its approval', async () => {
  const wizard = await detected({ ...ROUTES(withFiles), '/api/onboarding/pr/changes': { changes: CHANGES, error: null } });
  await nextTo(wizard, 'files');
  wizard.getState().choose({ drop: ['agent-skills'] });
  await nextTo(wizard, 'edits');
  wizard.getState().approve(true);
  wizard.getState().back();
  wizard.getState().choose({ drop: [] });
  expect(wizard.getState().approved).toBe(false);
  const { runSteps } = await import('./wizard-store.ts');
  expect(runSteps(wizard.getState().run!, wizard.getState().detection).at(-1)).toBe('files');
});
