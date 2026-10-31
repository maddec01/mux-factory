// The T3 project step: T3's projects, each with its provider and whether its repository shares a .lar-factory.json,
// and the ones that can't be picked. What we found: each detected fact, or Refused with why. Each question step: where
// its default came from, each option's cost line, Refused where access blocks it, and the choices it leaves for later.
// Work to import: each ticket with what it needs settled. Factory files and Repository edits: keep or drop each file,
// and the PR's changes to approve. Finish: the repository on the board, with the PR it opened.

import { expect, test } from 'vite-plus/test';
import type { BoardData, ImportableTicket, RepoConfig, SetupDetection } from '@lar-factory/shared';
import { $, fetchMock, mountPage, sample, settle, text } from '../../test/support.ts';
import { detection, dialog, empty, openOnboarding, posted, project, serve, type Route } from './onboarding-support.ts';

const rows = () => [...dialog()!.querySelectorAll<HTMLElement>('[data-choice]')];
const row = (name: string) => rows().find((r) => r.dataset.choice === name)!;
const radio = (name: string) => row(name).querySelector<HTMLElement>('[role="radio"]')!;
const badges = (name: string) => [...row(name).querySelectorAll('[data-slot="badge"]')].map(text);

test('each project shows its folder, repository, provider and whether it shares a .lar-factory.json', async () => {
  await openOnboarding([
    project('lar-web', { hasConfig: true }),
    project('lar-cli', { hasConfig: false }),
    project('lar-ios', { hasConfig: null }),
    project('lar-api', { repo: 'contoso/Fabrikam/lar-api', provider: 'Azure DevOps', hasConfig: null }),
  ]);
  expect(rows().map((r) => r.dataset.choice)).toEqual(['lar-web', 'lar-cli', 'lar-ios', 'lar-api', 'new']);
  expect(text(row('lar-web'))).toContain('/Users/me/Developer/lar-web · maddec01/lar-web');
  expect(badges('lar-web')).toEqual(['GitHub', 'Shared config']);
  expect(badges('lar-cli')).toEqual(['GitHub']);
  expect(badges('lar-ios')).toEqual(['GitHub']);
  expect(badges('lar-api')).toEqual(['Azure DevOps']);
  expect(text(body()), 'the step says what it asks once, above its body').not.toContain('Choose the repository folder where agents will work.');
});

test("an Azure DevOps repository whose project's name has a space shows it decoded", async () => {
  await openOnboarding([project('lar-api', { repo: 'contoso/Fabrikam%20Fiber/lar-api', provider: 'Azure DevOps', hasConfig: false })]);
  expect(text(row('lar-api'))).toContain('/Users/me/Developer/lar-api · contoso/Fabrikam Fiber/lar-api');
  expect(text(dialog())).not.toContain('%20');
});

test("a repository already on the board, or a folder with no provider's origin, shows but can't be picked", async () => {
  await openOnboarding([
    project('lar-server', { onBoard: true }),
    project('notes', { repo: null, provider: null, hasConfig: null }),
  ]);
  expect(badges('lar-server')).toEqual(['GitHub', 'on the board']);
  expect(text(row('notes'))).toContain('Choose a repository folder connected to GitHub or Azure DevOps.');
  for (const name of ['lar-server', 'notes']) {
    expect(radio(name).getAttribute('aria-disabled') ?? radio(name).hasAttribute('data-disabled').toString(), name).toBe('true');
    await settle(() => radio(name).click());
    expect(radio(name).getAttribute('aria-checked'), name).toBe('false');
  }
});

test('a repository still onboarding shows as onboarding, with its Resume to use instead', async () => {
  const data = { ...sample, repos: [], onboarding: [{ repo: 'maddec01/lar-cli', progress: { step: 'role', done: ['project'], answers: { projectId: 'lar-cli' } } }] };
  serve(data, [project('lar-cli', { onBoard: true })]);
  await mountPage(data);
  const { useWizardStore } = await import('./wizard-store.ts');
  await settle(() => useWizardStore.getState().start());
  expect(badges('lar-cli')).toEqual(['GitHub', 'onboarding']);
  expect(text(row('lar-cli'))).toContain('maddec01/lar-cli · Setup is already in progress. Close this window and choose Resume.');
});

test("a step that can't read T3's projects shows the problem with Retry", async () => {
  await openOnboarding({ error: "Can't read T3 Code's projects at /x" });
  const alert = dialog()!.querySelector('[role="alert"]')!;
  expect(text(alert)).toContain("Can't read T3 Code's projects at /x");
  expect(text(alert.querySelector('button')).trim()).toBe('Retry');
});

test('with no T3 project the step says so', async () => {
  await openOnboarding([]);
  expect(text(dialog()!.querySelector('[data-slot="modal-body"]'))).toContain('Add a repository folder to T3 Code to begin.');
});

test("while T3's projects are read the step shows a spinner", async () => {
  await openOnboarding([project('lar-web')]);
  fetchMock.mockImplementation(() => new Promise<Response>(() => {}));
  const { useWizardStore } = await import('./wizard-store.ts');
  await settle(() => void useWizardStore.getState().loadProjects());
  const reading = dialog()!.querySelector('[data-reading-projects]')!;
  expect(text(reading).trim()).toBe('Loading T3 Code projects...');
  expect(reading.querySelector('svg.animate-spin')).not.toBeNull();
});

/** Answers Create a new T3 project's post with `body` and `status`, leaving the other requests as they were served. */
function answerCreate(body: object, status = 200): void {
  const served = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => url === '/api/onboarding/projects' && init?.method === 'POST'
    ? new Response(JSON.stringify(body), { status }) : served(url));
}

const folderInput = () => dialog()!.querySelector<HTMLInputElement>('[data-new-folder]')!;
const addButton = () => dialog()!.querySelector<HTMLButtonElement>('[data-add-project]')!;

async function typeFolder(value: string): Promise<void> {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(folderInput(), value);
  await settle(() => folderInput().dispatchEvent(new Event('input', { bubbles: true })));
}

test('Add a folder to T3 Code takes a folder, adds it, and picks the new project', async () => {
  await openOnboarding([project('lar-web')]);
  expect(text(row('new'))).toContain('Add a folder to T3 Code');
  expect(folderInput(), 'the folder shows once the choice is made').toBeNull();
  await settle(() => radio('new').click());
  expect(addButton().disabled, 'Add waits for a folder').toBe(true);
  await typeFolder('~/Developer/lar-apple');
  answerCreate({ projects: [project('lar-web'), project('lar-apple')], projectId: 'lar-apple', error: null });
  await settle(() => addButton().click());
  await settle();
  expect(radio('lar-apple').getAttribute('aria-checked')).toBe('true');
  expect(folderInput()).toBeNull();
});

test("a failing t3 project add shows t3's message and keeps the step", async () => {
  await openOnboarding([project('lar-web')]);
  await settle(() => radio('new').click());
  await typeFolder('/Users/me/lar-apple');
  answerCreate({ error: 't3 could not add the project: Could not reach the T3 Code server.' }, 502);
  await settle(() => addButton().click());
  await settle();
  const alert = dialog()!.querySelector('[role="alert"]')!;
  expect(text(alert)).toContain('t3 could not add the project: Could not reach the T3 Code server.');
  expect(folderInput().value).toBe('/Users/me/lar-apple');
  expect(text(dialog()!.querySelector('[data-slot="modal-header"] h2'))).toBe('Repository');
});

const body = () => dialog()!.querySelector<HTMLElement>('[data-slot="modal-body"]')!;
const heading = () => text(dialog()!.querySelector('[data-slot="modal-header"] h2'));
const footer = (label: string) => [...dialog()!.querySelectorAll<HTMLButtonElement>('[data-slot="modal-footer"] button')].find((b) => text(b).trim() === label);
const later = () => [...body().querySelectorAll('[data-later] li')].map(text);
const origin = () => text(body().querySelector('[data-origin] [data-slot="badge"]'));
const option = (id: string) => body().querySelector<HTMLElement>(`[data-option="${id}"]`)!;
const optionBadges = (id: string) => [...option(id).querySelectorAll('[data-slot="badge"]')].map(text);
const box = (id: string) => option(id).querySelector<HTMLElement>('[role="checkbox"], input[type="checkbox"]')!;

async function type(into: HTMLInputElement, value: string): Promise<void> {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(into, value);
  await settle(() => into.dispatchEvent(new Event('input', { bubbles: true })));
}

const ticket = (number: number, parts: Partial<ImportableTicket> = {}): ImportableTicket => ({
  number, title: `Ticket ${number}`, url: `https://github.com/maddec01/lar-web/issues/${number}`, statuses: ['Ready'], untagged: false, workId: null, ...parts,
});

/** The calls the wizard makes for a repository detected as `found`, with `tickets` to import. */
const routes = (found: SetupDetection = detection(), tickets: ImportableTicket[] = [], more: Record<string, Route> = {}): Record<string, Route> => ({
  '/api/onboarding/detect': { detection: found, error: null }, '/api/onboarding/import/tickets': { tickets, error: null },
  '/api/onboarding/setup': { error: null }, ...more,
});

/** Opens the dialog over `data` with lar-web, picks it and presses Next until the step titled `title`. */
async function openAt(title: string, calls: Record<string, Route> = routes(), chosen = project('lar-web'), data?: BoardData): Promise<void> {
  await openOnboarding([chosen], calls, data);
  await settle(() => radio(chosen.name).click());
  for (let i = 0; i < 10 && heading() !== title; i++) {
    if (heading() === 'Repository role' && !body().querySelector<HTMLInputElement>('input')!.value) await type(body().querySelector('input')!, 'Web client');
    await settle(() => footer('Next')!.click());
  }
  expect(heading()).toBe(title);
}

const fact = (label: string) => text(body().querySelector(`[data-fact="${label}"] dd`));

test('What we found lists each detected fact, with what the login allows, refuses and leaves unverified', async () => {
  await openAt('What we found', routes(detection({
    access: { 'push-branch': 'refused', 'open-pr': 'unverified', 'publish-ticket': 'allowed', 'edit-ticket': 'unverified', 'tag-ticket': 'refused', 'comment-ticket': 'unverified', 'type-ticket': 'unverified', 'relate-ticket': 'unverified' },
    domainDocs: { found: { kind: 'repository', glossary: 'CONTEXT.md', adrs: 'docs/adr' } }, projectSkills: { found: ['tdd', 'web-style'] },
  })));
  expect(fact('Provider')).toBe('GitHub');
  expect(fact('Repository folder')).toBe('/Users/me/Developer/lar-web');
  expect(fact('Item source')).toBe("maddec01/lar-web's issues");
  expect(fact('Credential access')).toBe('Allowed: open issues. Refused: push branches, add labels. Unverified until needed: open pull requests, edit issues, post comments, set issue types, link issues.');
  expect(fact('Domain docs')).toBe('CONTEXT.md and docs/adr/');
  expect(fact('Factory files')).toBe('None found');
  expect(fact('Repository config')).toBe('None. Every setting is yours.');
  expect(fact('Project skills')).toBe('tdd, web-style');
  expect(later()).toEqual([
    "You'll be offered a shared Repository config when a setting is worth sharing with your team.",
    'Labels and agent guidance for the repository are offered when a feature would use them.',
  ]);
  expect(footer('Next')!.disabled).toBe(false);
});

test("a fact the login can't read shows Refused with why, and a folder agents can't use holds Next with Retry", async () => {
  await openAt('What we found', routes(detection({
    checkout: { refused: 'More than one T3 project points to maddec01/lar-web.' }, sharedConfig: { refused: "Can't read maddec01/lar-web with gh: HTTP 403" },
    factoryFiles: { refused: "Can't read maddec01/lar-web with gh: HTTP 403" },
  })));
  expect(fact('Repository config')).toBe("RefusedCan't read maddec01/lar-web with gh: HTTP 403");
  expect(text(body().querySelector('[data-fact="Factory files"] [data-slot="badge"]'))).toBe('Refused');
  expect(text(body().querySelector('[role="alert"]'))).toContain('More than one T3 project points to maddec01/lar-web.');
  expect(footer('Next')!.disabled).toBe(true);
  expect(later(), 'no config offer where it could not be read').toHaveLength(1);
});

test("a shared .lar-factory.json's defaults are named on What we found and preselected as From Repository config", async () => {
  await openAt('Repository role', routes(detection({ sharedConfig: { found: { defaults: { role: 'Web client', itemSource: { kind: 'issues' }, domainDocs: { kind: 'private' }, skills: [] } } } })));
  expect(origin()).toBe('From Repository config');
  expect(body().querySelector<HTMLInputElement>('input')!.value).toBe('Web client');
  await type(body().querySelector('input')!, 'Admin web client');
  expect(origin()).toBe('Changed');
  await settle(() => footer('Back')!.click());
  await settle(() => footer('Back')!.click());
  expect(fact('Repository config')).toBe('.lar-factory.json supplies the role, item source, domain-doc location and skills. You can change each one here.');
  expect(later(), 'no offer of a config it has').toEqual(['Labels and agent guidance for the repository are offered when a feature would use them.']);
});

test('the role step holds Next until it has a role, saying why', async () => {
  await openAt('Repository role');
  await type(body().querySelector('input')!, '');
  expect(footer('Next')!.disabled).toBe(true);
  expect(text(body().querySelector('[data-problem]'))).toBe('Describe what this repository does to continue.');
});

test('Write consent preselects every allowed write, shows a cost line on each, Refused ones locked off, and names publishing writes for later', async () => {
  await openAt('Write consent', routes(detection({ access: { 'push-branch': 'refused', 'open-pr': 'unverified', 'publish-ticket': 'allowed', 'edit-ticket': 'allowed', 'tag-ticket': 'allowed', 'comment-ticket': 'unverified', 'type-ticket': 'unverified', 'relate-ticket': 'unverified' } })));
  expect(origin()).toBe('Detected');
  expect(text(body().querySelector('[data-origin]'))).toContain('The default is preselected.');
  expect(['publish-ticket', 'tag-ticket'].map((id) => body().querySelector(`[data-option="${id}"]`)), 'no control for a later feature').toEqual([null, null]);
  expect(optionBadges('push-branch')).toEqual(['Refused']);
  expect(optionBadges('open-pr')).toEqual(['Unverified']);
  expect(text(option('push-branch'))).toContain("Refused: your GitHub access doesn't allow it.");
  expect(text(option('open-pr'))).toContain('How builds deliver. Off: builds stop at a pushed branch.');
  const checked = (id: string) => box(id).getAttribute('aria-checked') ?? String((box(id) as HTMLInputElement).checked);
  expect(['push-branch', 'open-pr', 'edit-ticket'].map(checked)).toEqual(['false', 'false', 'true']);
  expect(box('push-branch').hasAttribute('disabled') || box('push-branch').getAttribute('aria-disabled') === 'true' || box('push-branch').hasAttribute('data-disabled')).toBe(true);
  await settle(() => box('open-pr').click());
  expect(checked('open-pr')).toBe('true');
  expect(origin()).toBe('Changed');
  expect(text(body().querySelector('[data-origin]')), 'a changed answer is no longer the default').not.toContain('preselected');
  expect(later()).toEqual(["You'll choose whether the factory may open and label issues, map its kinds to your labels and choose how to publish the first time you publish refined work."]);
});

test("Domain docs offers the repository's docs or private drafts, Refused when the build PR is, and names publishing drafts for later", async () => {
  await openAt('Domain docs', routes(detection({ domainDocs: { found: { kind: 'repository', glossary: 'GLOSSARY.md', adrs: 'docs/adr' } },
    access: { ...detection().access, 'open-pr': 'refused' } })));
  expect(text(choice('repository'))).toContain('Use GLOSSARY.md and docs/adr/');
  expect(text(choice('repository'))).toContain('Refused');
  expect(text(choice('private'))).toContain('Only you see them, on this Mac, until a build PR publishes them.');
  expect(radio('private').getAttribute('aria-checked'), 'the default skips the refused option').toBe('true');
  expect(later()).toEqual(["You'll choose whether to publish private drafts when a build first writes them."]);
});

test('Project skills lists each skill found unticked, and names Clash resolution for later', async () => {
  await openAt('Project skills', routes(detection({ projectSkills: { found: ['tdd', 'grill-me'] } })));
  expect(text(body().querySelector('[data-origin]')), 'nothing is ticked, so nothing is preselected').toBe('Detected Found in the repository. Tick the ones builds should follow.');
  expect([...body().querySelectorAll('[data-option]')].map((o) => (o as HTMLElement).dataset.option)).toEqual(['tdd', 'grill-me']);
  expect(text(option('tdd'))).toContain('Builds follow it when they write and test code.');
  expect(later()).toEqual(["If a project rule blocks factory work, you'll choose how to resolve it then."]);
  expect(footer('Finish'), 'the last step for a repository with no factory files').toBeDefined();
});

const choice = (id: string) => body().querySelector<HTMLElement>(`[data-choice="${id}"]`)!;
const ticketRow = (n: number) => body().querySelector<HTMLElement>(`[data-ticket="${n}"]`)!;

test("Work to import lists each ticket with a status, those recorded already, and what a ticked one needs settled", async () => {
  await openAt('Work to import', routes(detection(), [ticket(3), ticket(4, { statuses: ['Ready', 'In progress'] }), ticket(6, { workId: 'W-2' })]));
  expect(text(ticketRow(3))).toContain('#3Ticket 3Ready');
  expect(text(ticketRow(6))).toContain('Recorded as W-2');
  expect(text(ticketRow(4))).toContain('Choose its Status, or untick it.');
  expect(footer('Next')!.disabled).toBe(true);
  const select = ticketRow(4).querySelector<HTMLSelectElement>('select')!;
  select.value = 'In progress';
  await settle(() => select.dispatchEvent(new Event('change', { bubbles: true })));
  expect(footer('Next')!.disabled).toBe(false);
});

test('Next imports the ticked tickets and shows the reason for each one the board refuses', async () => {
  await openAt('Work to import', routes(detection(), [ticket(3), ticket(8)], {
    '/api/onboarding/import': { imported: [{ number: 3, workId: 'W-3', created: true, threads: 0 }], refused: [{ number: 8, reason: 'maddec01/lar-web#8 is no longer open.' }], error: null },
  }));
  await settle(() => footer('Next')!.click());
  expect(heading()).toBe('Work to import');
  expect(text(ticketRow(8))).toContain('maddec01/lar-web#8 is no longer open.');
});

const withFiles = (parts: Partial<SetupDetection> = {}) => detection({
  factoryFiles: { found: [{ kind: 'config', paths: ['.lar-factory.json'] }, { kind: 'agent-skills', paths: ['AGENTS.md'] }] }, ...parts });

test("an existing repository's factory files are kept by default, and dropping is Refused when the PR is", async () => {
  await openAt('Factory files', routes(withFiles({ access: { ...detection().access, 'push-branch': 'refused' } })));
  expect(text(option('agent-skills'))).toContain('## Agent skills in AGENTS.md');
  expect(optionBadges('config')).toEqual(['Refused']);
  expect(text(option('config'))).toContain("Refused: your access can't open the PR that drops it.");
  expect(footer('Finish')).toBeDefined();
});

/** An onboarded repository with `role`, connected to `connections`. */
const onboarded = (name: string, role: string, connections: string[] = []) =>
  ({ repo: `maddec01/${name}`, role, labels: [], setup: { connections } }) as unknown as RepoConfig;

test('Connections lists only the other onboarded repositories, ticking the ones their roles relate, and saves the ticked ones on Finish', async () => {
  const repos = [onboarded('lar-api', 'API server lar-web talks to'), onboarded('lar-docs', 'Product docs site'), onboarded('lar-ios', 'iOS app', ['maddec01/lar-web'])];
  await openAt('Connections', routes(), project('lar-web'), { ...empty, repos });
  expect([...body().querySelectorAll<HTMLElement>('[data-option]')].map((o) => o.dataset.option)).toEqual(['maddec01/lar-api', 'maddec01/lar-docs', 'maddec01/lar-ios']);
  expect(text(option('maddec01/lar-docs'))).toContain('Product docs site');
  const ticked = () => ['maddec01/lar-api', 'maddec01/lar-docs', 'maddec01/lar-ios'].filter((id) => box(id).getAttribute('aria-checked') === 'true' || (box(id) as HTMLInputElement).checked);
  expect(ticked(), 'the role that names lar-web, and the pair kept from an earlier onboarding').toEqual(['maddec01/lar-api', 'maddec01/lar-ios']);
  await settle(() => box('maddec01/lar-ios').click());
  await settle(() => box('maddec01/lar-docs').click());
  expect(posted('/api/onboarding/setup'), 'nothing saves until the user confirms').toEqual([]);
  for (let i = 0; i < 5 && !footer('Finish'); i++) await settle(() => footer('Next')!.click());
  await settle(() => footer('Finish')!.click());
  expect(posted('/api/onboarding/setup').map((b) => b.connections)).toEqual([['maddec01/lar-api', 'maddec01/lar-docs']]);
});

test('Connections says so when no other repository is onboarded, offering nothing to tick', async () => {
  await openAt('Connections');
  expect(body().querySelector('[data-option]')).toBeNull();
  expect(text(body())).toContain('No other repository is on the board yet');
  for (let i = 0; i < 5 && !footer('Finish'); i++) await settle(() => footer('Next')!.click());
  await settle(() => footer('Finish')!.click());
  expect(posted('/api/onboarding/setup').map((b) => b.connections)).toEqual([[]]);
});

const CHANGES = [{ kind: 'agent-skills' as const, path: 'AGENTS.md', removed: true as const, preview: { before: '# Agents\n## Agent skills\n<b>x</b>', after: '# Agents\n' } }];
const PR = 'https://github.com/maddec01/lar-web/pull/9';

test('a repository with existing factory files completes: drop one, review and approve the PR, then Finish saves and opens it', async () => {
  await openAt('Factory files', routes(withFiles(), [], { '/api/onboarding/pr/changes': { changes: CHANGES, error: null }, '/api/onboarding/pr': { prUrl: PR, error: null } }));
  await settle(() => box('agent-skills').click());
  await settle(() => footer('Next')!.click());
  expect(heading()).toBe('Repository edits');
  expect(text(body().querySelector('[data-change="AGENTS.md"]'))).toContain('Removes the ## Agent skills block.');
  expect(body().querySelector('pre')!.innerHTML, 'repository text is escaped').toContain('&lt;b&gt;x&lt;/b&gt;');
  expect(footer('Finish')!.disabled, 'Finish waits for approval').toBe(true);
  await settle(() => body().querySelector<HTMLElement>('[data-approve] [role="checkbox"], [data-approve] input')!.click());
  await settle(() => footer('Finish')!.click());
  expect(heading()).toBe('Onboarded');
  expect(text(body())).toContain('maddec01/lar-web is on the board');
  expect(text(body().querySelector('[data-pr-opened]'))).toContain('maddec01/lar-web#9 holds the edits you approved');
  expect(posted('/api/onboarding/pr')).toEqual([{ repo: 'maddec01/lar-web', edits: { drop: ['agent-skills'] } }]);
  await settle(() => footer('Go to the board')!.click());
  expect(dialog()).toBeNull();
});

test('a repository with no factory files completes with Finish on Project skills, writing nothing to it', async () => {
  await openAt('Project skills');
  await settle(() => footer('Finish')!.click());
  expect(heading()).toBe('Onboarded');
  expect(text(body())).toContain('Nothing was written to the repository.');
  expect(posted('/api/onboarding/setup')).toHaveLength(1);
  expect(posted('/api/onboarding/pr')).toEqual([]);
});

test("a save the board refuses shows why on the last step", async () => {
  await openAt('Project skills', routes(detection(), [], { '/api/onboarding/setup': { error: 'maddec01/lar-web is onboarded already.' } }));
  await settle(() => footer('Finish')!.click());
  expect(heading()).toBe('Project skills');
  expect(text(body().querySelector('[role="alert"]'))).toContain('maddec01/lar-web is onboarded already.');
});

test("an Azure DevOps repository asks for its team, with the shared config's team preselected", async () => {
  const azure = detection({ repo: 'contoso/Fabrikam/lar-api', provider: 'Azure DevOps',
    itemSources: { found: [{ kind: 'azure-board', team: 'Fabrikam Team' }, { kind: 'azure-board', team: 'Web' }] },
    sharedConfig: { found: { defaults: { itemSource: { kind: 'azure-board', team: 'Web' } } } } });
  await openAt('Item source', routes(azure), project('lar-api', { repo: 'contoso/Fabrikam/lar-api', provider: 'Azure DevOps' }));
  expect(origin()).toBe('From Repository config');
  expect(radio('team:Web').getAttribute('aria-checked')).toBe('true');
  expect(text(choice('team:Fabrikam Team'))).toContain("The team's backlog and current sprint appear on the board.");
});
