// The item dialog: opened through its store, it shows an item's repository, status and agent work figures in its header,
// a meta area of labels under the title, a progress bar with the slices as an overview, then sub-tickets and pull
// requests in a sidebar, and its footer carries GitHub and the action the item's status asks for.

import { expect, test, vi } from 'vite-plus/test';
import { $, $$, answer, holdPosts, mountPage, moved, posted, pressMenu, sample, settle, text, toast } from '../../test/support.ts';
import type { Blocker, BoardData, DependencyHold, Item, ItemThread } from '@lar-factory/shared';

const dialog = () => $('[data-item-dialog]');
const inDialog = <T extends Element = HTMLElement>(selector: string) => dialog()!.querySelector<T>(selector);
const footer = () => inDialog('[data-slot="modal-footer"]')!;
/** The item dialog's `attr` button, not the board's behind it. */
const button = (attr: string, id: string) => inDialog<HTMLButtonElement>(`[data-${attr}="${id}"]`)!;
/** A sidebar section by the start of its heading. */
const section = (heading: string) => $$('[data-item-dialog] aside section').find((s) => text(s.querySelector('h2')).startsWith(heading))!;
const press = async (el: HTMLElement) => {
  el.focus();
  await settle(() => el.click());
};
const without = (id: string): BoardData => ({ ...sample, items: sample.items.filter((i) => i.id !== id) });

/** Opens the item dialog on `itemId` through its store, as every list on the page does. */
async function openItem(itemId: string): Promise<void> {
  const { useItemDialogStore } = await import('./item-dialog-store.ts');
  await settle(() => useItemDialogStore.getState().open(itemId));
}

test('the dialog shows the repository, status, update time, blockers, numbered title, parent and a progress bar', async () => {
  await mountPage();
  await openItem('I_sample13');
  expect(dialog()!.getAttribute('role')).toBe('dialog');
  const summary = inDialog('[data-item-summary] > div')!;
  expect(text(summary)).toBe('lar-server Ready· updated 1h agoblocked by 1. Blocked by #202 until it completes');
  expect(text(inDialog('[data-slot="modal-header"] h2'))).toBe('#140 Owner accounts');
  const parent = inDialog<HTMLAnchorElement>('[data-item-parent] a')!;
  expect([text(parent), parent.href]).toEqual(['#200 lar cloud: website sign-in and relay', 'https://github.com/maddec01/lar-server/issues/200']);
  expect(steps()).toHaveLength(10);
  expect(text(inDialog('[data-meta]'))).toContain('No T3 thread has worked on this yet.');
  expect(text(inDialog('[data-labels]'))).toBe('build');
});

/** The progress bar's ten step segments. */
const steps = () => $$('[data-item-dialog] [data-progress] [data-steps] > li');

test('the progress bar names the current step on its segment and every step in a title and an accessible label', async () => {
  await mountPage();
  await openItem('I_sample13');
  const current = steps()[4]!;
  expect([current.getAttribute('aria-label'), current.getAttribute('aria-current'), text(current)]).toEqual(['Step 5 of 10: Ready', 'step', 'Ready5/10']);
  expect(steps().map((s) => s.title)).toEqual(['List', 'Queued', 'Shaping', 'Needs you', 'Ready', 'In progress', 'Review', 'Verify', 'Ready to merge', 'Done']);
  expect(steps().filter((s) => s !== current).map((s) => text(s))).toEqual(Array(9).fill(''));
  expect(steps().filter((s) => s.hasAttribute('aria-current'))).toEqual([current]);
});

test('slices show as an overview under the progress bar, not in the sidebar, with a bar of their own while the item is not at work', async () => {
  await mountPage();
  await openItem('I_sample13');
  const slices = inDialog('[data-slices]')!;
  expect(text(slices.querySelector('p'))).toBe('Slices · 1/3 done');
  expect([...slices.querySelectorAll('ul > li')].map(text)).toEqual(['#144Owner table and sign-updone', '#145Sign-in sessionsactive', '#146Owner settings pagewaiting']);
  expect(slices.querySelectorAll('ol > li'), 'a small bar of the slices').toHaveLength(3);
  expect(steps()[4]!.querySelector('ol'), 'the Ready segment is not subdivided').toBeNull();
  expect($$('[data-item-dialog] aside h2').map(text)).toEqual(['Sub-tickets']);
});

test('an In progress item with slices subdivides its current segment, a mini segment for each slice', async () => {
  const slices = sample.items.find((i) => i.id === 'I_sample13')!.slices;
  await mountPage({ ...sample, items: sample.items.map((i) => (i.id === 'I_sample14' ? { ...i, slices } : i)) });
  await openItem('I_sample14');
  expect([...steps()[5]!.querySelectorAll<HTMLElement>('ol > li')].map((s) => s.title)).toEqual(['#144 Owner table and sign-up', '#145 Sign-in sessions', '#146 Owner settings page']);
  expect(text(inDialog('[data-slices] p'))).toBe('Slices · 1/3 done');
  expect(inDialog('[data-slices] ol'), 'the bar is in the track, not repeated').toBeNull();
  expect(inDialog('[data-slices] ul')!.children).toHaveLength(3);
});

test('the labels, people and dates sit in a meta area under the title, and the sidebar holds only relations', async () => {
  await mountPage();
  await openItem('I_sample13');
  const meta = text(inDialog('[data-meta]'));
  expect(meta).toMatch(/Author.*maddec01.*Assignees.*maddec01.*claude-bot.*Labels.*build.*Milestone.*Cloud v0\.1.*Created.*Updated/);
  expect(inDialog('[data-meta]')!.closest('aside'), 'not in the sidebar').toBeNull();
  expect(text(inDialog('aside'))).not.toMatch(/Author|Assignees|Labels|Created|Updated|Agent work/);
});

test('an item with no slices, pull requests or sub-tickets has no sidebar', async () => {
  await mountPage();
  await openItem('I_sample01');
  expect(inDialog('aside')).toBeNull();
});

test('the header bar holds the agent work figures and the close button', async () => {
  await mountPage();
  await openItem('I_sample14');
  const close = inDialog<HTMLButtonElement>('header [aria-label="Close"]')!;
  expect(inDialog('header')!.contains(inDialog('[data-agent-work]'))).toBe(true);
  expect(dialog()!.querySelectorAll('[aria-label="Close"]'), 'the popup draws no second one').toHaveLength(1);
  await press(close);
  expect(dialog()).toBeNull();
});

test('the dialog lays out by its own width and never hides an overflow', async () => {
  await mountPage();
  await openItem('I_sample13');
  expect(inDialog('[data-item-body]')!.classList.contains('@container')).toBe(true);
  expect(inDialog('[data-item-body]')!.className).not.toMatch(/overflow/);
});

test('the dialog shows the hint, each pull request with its checks, and the agent work figures', async () => {
  await mountPage();
  await openItem('I_sample14');
  const work = inDialog('header [data-agent-work]')!;
  expect(text(inDialog('[data-item-summary]'))).toBe('lar-apple In progress· updated 25m ago');
  expect(text(inDialog('header'))).toBe('#30 Chapter markers in the scrubber$24.18 · 2h 14m · 16.6M tokens · 1h 20m wall');
  expect(work.title).toBe('Cost $24.18 · Agent time 2h 14m · Tokens 16.6M · Wall time 1h 20m');
  expect(inDialog('[data-meta] [data-agent-work]')!.className, 'a narrow dialog shows them in the meta area instead').toContain('@min-[40rem]:hidden');
  expect(work.className, 'a wide one in the header').toContain('@max-[40rem]:hidden');
  const pr = section('Pull requests').querySelector('li')!;
  expect([text(pr), pr.querySelector('a')!.getAttribute('href')]).toEqual(['PR #33 (draft)checks running', 'https://github.com/maddec01/lar-apple/pull/33']);

  await openItem('I_sample16');
  expect(text(inDialog('[data-item-body] > div:nth-child(2)')), 'the hint').toBe('Test it with the steps in the PR, then merge');
  expect(inDialog('[data-agent-work]'), 'no figures').toBeNull();
  expect(text(inDialog('[data-meta]')), 'unreadable stats say so').toContain('The T3 Code database could not be read');
});

/** The footer's buttons and links, left to right, as their text, with " (disabled: <title>)" on a disabled one. */
const footerControls = () => [...footer().querySelectorAll<HTMLElement>('button, a')].map((el) =>
  `${text(el).trim()}${(el as HTMLButtonElement).disabled ? ` (disabled: ${el.title})` : ''}`);

test.each([
  ['List', 'I_sample01', ['Abandon', 'GitHub', 'Queue']],
  ['Queued', 'I_sample05', ['Back to List', 'Abandon', 'GitHub', 'Start refining ▾']],
    ['Shaping', 'I_sample07', ['GitHub', 'Open thread']],
  ['Needs you', 'I_sample11', ['GitHub', 'Answer in T3 (disabled: No T3 thread has worked on this yet)']],
  ['blocked Ready', 'I_sample13', ['GitHub', 'Start after #202 ▾']],
  ['In progress', 'I_sample14', ['GitHub', 'Open thread']],
  ['Review', 'I_sample15', ['GitHub', 'Open thread']],
  ['Verify', 'I_sample16', ['GitHub', 'Verify build']],
  ['Ready to merge', 'I_sample17', ['GitHub', 'Merge PR']],
  ['Done', 'I_sample19', ['GitHub']],
])('a %s item’s footer has its action', async (_status, itemId, controls) => {
  await mountPage();
  await openItem(itemId);
  expect(footerControls()).toEqual(controls);
});

test.each([
  ['Verify', 'Verify build', 'I_sample16'],
  ['Ready to merge', 'Merge PR', 'I_sample17'],
])('a %s item with no linked pull request has %s disabled, its title saying why', async (_status, label, itemId) => {
  await mountPage({ ...sample, items: sample.items.map((i) => (i.id === itemId ? { ...i, linkedPrs: [] } : i)) });
  await openItem(itemId);
  expect(footerControls().at(-1)).toBe(`${label} (disabled: No pull request is linked to this item yet)`);
});

test('GitHub opens the item, and Verify build and Merge PR open its pull request, in a new tab', async () => {
  await mountPage();
  await openItem('I_sample16');
  const links = [...footer().querySelectorAll('a')].map((a) => [text(a).trim(), a.getAttribute('href'), a.target]);
  expect(links).toEqual([['GitHub', 'https://github.com/maddec01/lar-apple/issues/31', '_blank'], ['Verify build', 'https://github.com/maddec01/lar-apple/pull/32', '_blank']]);
  const verify = footer().querySelector<HTMLAnchorElement>('[data-pr-link]')!;
  expect([verify.dataset.kind, Boolean(verify.querySelector('[data-slot="icon"] .lucide-git-pull-request'))], 'an Open with the pull request icon').toEqual(['open', true]);
  expect(verify.className.split(' '), "a link takes its kind's height, not the Copy's").not.toContain('h-9');
  await openItem('I_sample17');
  expect(footer().querySelector('a:last-child')!.getAttribute('href')).toMatch(/\/pull\/\d+$/);
});

test('an Azure work item\'s footer opens it on Azure DevOps', async () => {
  const url = 'https://dev.azure.com/contoso/Fabrikam%20Fiber/_workitems/edit/31';
  await mountPage({ ...sample, items: sample.items.map((i) => (i.id === 'I_sample01' ? { ...i, repo: 'contoso/Fabrikam%20Fiber/lar-apple', url } : i)) });
  await openItem('I_sample01');
  expect([...footer().querySelectorAll('a')].map((a) => [text(a).trim(), a.getAttribute('href')])).toEqual([['Azure DevOps', url]]);
});

test('a Queued item blocked by an open issue has only Start after in the footer', async () => {
  await mountPage({ ...sample, items: sample.items.map((i) => (i.id === 'I_sample05'
    ? { ...i, blockers: [{ number: 202, repo: 'maddec01/lar-server', state: 'open' as const }] } : i)) });
  await openItem('I_sample05');
  expect(footerControls()).toEqual(['Back to List', 'Abandon', 'GitHub', 'Start after #202 ▾']);
});

/** The sample with `itemId`'s threads replaced. */
const withThreads = (itemId: string, threads: Item['threads'], data: BoardData = sample): BoardData =>
  ({ ...data, items: data.items.map((i) => (i.id === itemId ? { ...i, threads } : i)) });
const thread = (id: string, state: ItemThread['state']): ItemThread => ({ id, title: `Thread ${id}`, state, updated: '2026-10-21T09:00:00.000Z' });
/** The footer's last control: the item's status action. */
const statusAction = () => footer().querySelector<HTMLElement>(':scope > span:last-child > :last-child')!;

test('Open thread and Answer in T3 link to the latest thread in T3 Code, in the same tab', async () => {
  await mountPage(withThreads('I_sample10', [thread('new', 'running'), thread('old', 'done')]));
  await openItem('I_sample10');
  const open = statusAction() as HTMLAnchorElement;
  expect([text(open), open.getAttribute('href'), open.target]).toEqual(['Open thread', 't3code://threads/sample-environment/new', '']);

  await openItem('I_sample12');
  const answerLink = statusAction() as HTMLAnchorElement;
  expect([text(answerLink), answerLink.getAttribute('href')]).toEqual(['Answer in T3', 't3code://threads/sample-environment/sample-thread-202']);
});

test.each([
  ['T3 Code\'s database can\'t be read', withThreads('I_sample10', 'unavailable'), 'The T3 Code database could not be read'],
  ['T3 Code\'s environment id is missing', { ...sample, t3EnvironmentId: undefined }, 'T3 Code hasn\'t written its environment id'],
])('Open thread is disabled when %s, and its title says so', async (_case, data, reason) => {
  await mountPage(data);
  await openItem('I_sample10');
  expect(footerControls()).toEqual(['GitHub', `Open thread (disabled: ${reason})`]);
});

test("a Queued item has Start refining disabled in the footer until onboarding's PR merges while its repository is still onboarding", async () => {
  await mountPage({ ...sample, onboarding: [{ repo: 'maddec01/lar-server', progress: { step: 'pr', done: ['project'], answers: { projectId: 'p1' } } }] });
  await openItem('I_sample05');
  expect(footerControls()).toEqual(['Back to List', 'Abandon', 'GitHub', "Start refining (disabled: Waits for onboarding to finish)"]);
});

test.each([['running'], ['needs you']] as const)('a Queued item with a %s thread offers Open thread instead of Start refining, and neither Back to List nor Abandon', async (state) => {
  await mountPage(withThreads('I_sample05', [thread('live', state)]));
  await openItem('I_sample05');
  expect(footerControls()).toEqual(['GitHub', 'Open thread']);
  expect(statusAction().getAttribute('href')).toBe('t3code://threads/sample-environment/live');
});

test('a Queued item whose threads are all done still offers Start refining', async () => {
  await mountPage(withThreads('I_sample05', [thread('old', 'done')]));
  await openItem('I_sample05');
  expect(footerControls().at(-1)).toBe('Start refining ▾');
});

test('Queue in the dialog shows it in flight, then shows the item Queued, says so, and moves focus to Start refining', async () => {
  holdPosts();
  await mountPage();
  await openItem('I_sample01');
  await press(button('queue', 'I_sample01'));
  expect([text(button('queue', 'I_sample01')), button('queue', 'I_sample01').getAttribute('aria-disabled')]).toEqual(['Queuing…', 'true']);
  expect(posted()).toEqual([['/api/queue', { itemId: 'I_sample01' }]]);

  await answer({ error: null, board: moved('I_sample01', 'Queued') });
  expect(text(inDialog('[data-item-summary]'))).toMatch(/ Queued· /);
  expect(text(toast())).toBe(`Moved #61 ${sample.items[0]!.title} to Queued. View item`);
  expect(document.activeElement).toBe(button('start', 'I_sample01'));
});

test('a failed Queue stays in the dialog with a close button, which hands focus back to Queue', async () => {
  holdPosts();
  await mountPage();
  await openItem('I_sample02');
  await press(button('queue', 'I_sample02'));
  await answer({ error: 'Could not set Queued.' }, 502);
  expect(text(inDialog('.action-error [role="alert"]'))).toBe('Could not set Queued.');
  const close = inDialog<HTMLButtonElement>('.action-error button.dismiss')!;
  await press(close);
  expect(inDialog('.action-error')).toBeNull();
  expect(document.activeElement).toBe(button('queue', 'I_sample02'));
});

test("Abandon is greyed out with the reason on an item whose type can't be abandoned", async () => {
  const refusal = "Issue has no Removed state in Fabrikam Fiber, so the board can't abandon it. Close or delete it in Azure DevOps.";
  await mountPage({ ...sample, items: sample.items.map((i) => (i.id === 'I_sample01' ? { ...i, abandonRefusal: refusal } : i)) });
  await openItem('I_sample01');
  expect(footerControls()).toEqual([`Abandon (disabled: ${refusal})`, 'GitHub', 'Queue']);
  const abandon = button('abandon', 'I_sample01');
  expect(abandon.className, 'pointer events stay on, so the title shows').toContain('disabled:pointer-events-auto');
  const reason = footer().querySelector<HTMLElement>('[data-abandon-refusal]')!;
  expect(text(reason), 'a visible line says why').toBe(refusal);
  expect(abandon.getAttribute('aria-describedby')).toBe(reason.id);
});

test('Start refining opens the model menu, and picking a model starts the item and tags it Started', async () => {
  const withChoices: BoardData = { ...sample, capture: { session: 's1', enabled: true }, modelChoices: [{ instanceId: 'codex', name: 'Codex', models: [{ slug: 'gpt-5.5', label: 'GPT-5.5' }] }] };
  holdPosts(withChoices);
  await mountPage(withChoices);
  await openItem('I_sample05');
  await pressMenu(button('start', 'I_sample05'));
  await settle(() => vi.advanceTimersByTime(20));
  expect($$('[role="menu"] [role="menuitemradio"]').map(text)).toEqual(['T3 default', 'GPT-5.5']);
  await settle(() => $$('[role="menu"] [role="menuitemradio"]')[1]!.click());
  expect(posted()).toEqual([['/api/start', { session: 's1', itemId: 'I_sample05', model: { instanceId: 'codex', model: 'gpt-5.5' } }]]);
  expect(text(button('start', 'I_sample05'))).toBe('Starting…');

  await answer({ thread: { threadId: 'thread-1', title: 'Other title' }, error: null });
  const tag = inDialog('[data-start-result="I_sample05"]')!;
  expect(text(tag)).toBe('Started');
  expect(document.activeElement, 'focus moves to the dialog’s tag').toBe(tag);
  expect(inDialog('[data-back-to-list], [data-abandon]'), 'a started item can’t go back').toBeNull();
  expect(text(toast())).toBe('Refining started for #129. Open thread');
});

test('a failed Start shows in the dialog and offers Retry start', async () => {
  holdPosts();
  await mountPage({ ...sample, capture: { session: 's1', enabled: true } });
  await openItem('I_sample05');
  await pressMenu(button('start', 'I_sample05'));
  await settle(() => vi.advanceTimersByTime(20));
  await settle(() => $$('[role="menu"] [role="menuitemradio"]')[0]!.click());
  await answer({ error: 'T3 is not running.' }, 502);
  expect(text(inDialog('p.start [role="alert"]'))).toBe('T3 is not running.');
  expect(text(button('start', 'I_sample05'))).toBe('Retry start ▾');
});

/** The sample with #140's blocker closed, so its Start build runs, and writes on. */
const readyBuild: BoardData = {
  ...withThreads('I_sample13', undefined), capture: { session: 's1', enabled: true },
  items: sample.items.map((i) => (i.id === 'I_sample13' ? { ...i, blockers: [{ number: 202, repo: 'maddec01/lar-server', state: 'closed' }] } : i)),
};

test('Start build in a Ready item’s footer sends the build, then tags it Started', async () => {
  holdPosts(readyBuild);
  await mountPage(readyBuild);
  await openItem('I_sample13');
  expect(footerControls()).toEqual(['GitHub', 'Start build ▾']);
  await pressMenu(button('start', 'I_sample13'));
  await settle(() => vi.advanceTimersByTime(20));
  await settle(() => $$('[role="menu"] [role="menuitemradio"]')[0]!.click());
  expect(posted()).toEqual([['/api/start-build', { session: 's1', itemId: 'I_sample13' }]]);
  await answer({ thread: { threadId: 'thread-1', title: 'Build maddec01/lar-server#140' }, error: null });
  expect(text(inDialog('[data-start-result="I_sample13"]'))).toBe('Started');
});

const DRIFT = { thread: null, error: 'lar-build changed since Lar Factory installed it. Replace and start, or start anyway.', drift: ['lar-build'] };

test.each([['Replace and start', 'replace'], ['Start anyway', 'keep']] as const)(
  'Start build with Drift asks first, and %s sends the build again with that choice', async (label, drift) => {
    holdPosts(readyBuild);
    await mountPage(readyBuild);
    await openItem('I_sample13');
    await pressMenu(button('start', 'I_sample13'));
    await settle(() => vi.advanceTimersByTime(20));
    await settle(() => $$('[role="menu"] [role="menuitemradio"]')[0]!.click());
    await answer(DRIFT, 409);
    const dialog = $('#drift-choice')!;
    expect(dialog.getAttribute('role')).toBe('alertdialog');
    expect(text(dialog)).toContain('lar-build changed since Lar Factory installed it.');
    expect($$('#drift-choice [data-slot="modal-footer"] button').map(text)).toEqual(['Cancel', 'Start anyway', 'Replace and start']);
    expect($('#drift-choice [type="submit"]')!.textContent, 'Replace and start is the default').toBe('Replace and start');
    await settle(() => vi.advanceTimersByTime(50));
    expect(document.activeElement, 'focus starts on the default').toBe($('#drift-choice [type="submit"]'));
    expect(inDialog('p.start [role="alert"]'), 'the question is no failure').toBeNull();
    await settle(() => $$<HTMLButtonElement>('#drift-choice [data-slot="modal-footer"] button').find((b) => text(b) === label)!.click());
    expect($('#drift-choice')).toBeNull();
    expect(posted()).toEqual([
      ['/api/start-build', { session: 's1', itemId: 'I_sample13' }],
      ['/api/start-build', { session: 's1', itemId: 'I_sample13', drift }],
    ]);
    await answer({ thread: { threadId: 'thread-1', title: 'Build maddec01/lar-server#140' }, error: null });
    expect(text(inDialog('[data-start-result="I_sample13"]'))).toBe('Started');
  });

test('Cancel on the Drift question starts nothing and leaves Start build', async () => {
  holdPosts(readyBuild);
  await mountPage(readyBuild);
  await openItem('I_sample13');
  await pressMenu(button('start', 'I_sample13'));
  await settle(() => vi.advanceTimersByTime(20));
  await settle(() => $$('[role="menu"] [role="menuitemradio"]')[0]!.click());
  await answer(DRIFT, 409);
  await settle(() => $$<HTMLButtonElement>('#drift-choice [data-slot="modal-footer"] button')[0]!.click());
  expect($('#drift-choice')).toBeNull();
  expect(posted()).toHaveLength(1);
  expect(text(button('start', 'I_sample13'))).toBe('Start build ▾');
});

test('a build the board started, through Start after or from another page, shows Started at once', async () => {
  await mountPage({ ...readyBuild, startedBuilds: { I_sample13: { threadId: 'build-1', title: 'Build maddec01/lar-server#140' } } });
  await openItem('I_sample13');
  const tag = inDialog('[data-start-result="I_sample13"]')!;
  expect([text(tag), tag.getAttribute('title')]).toEqual(['Started', 'T3 thread build-1']);
  expect(footerControls()).toEqual(['GitHub']);
});

test('a failed Start build shows in the dialog and offers Retry start', async () => {
  holdPosts(readyBuild);
  await mountPage(readyBuild);
  await openItem('I_sample13');
  await pressMenu(button('start', 'I_sample13'));
  await settle(() => vi.advanceTimersByTime(20));
  await settle(() => $$('[role="menu"] [role="menuitemradio"]')[0]!.click());
  await answer({ thread: null, error: 'No T3 project is a checkout of maddec01/lar-server; add the checkout in T3 Code' }, 409);
  expect(text(inDialog('p.start [role="alert"]'))).toBe('No T3 project is a checkout of maddec01/lar-server; add the checkout in T3 Code');
  expect(text(button('start', 'I_sample13'))).toBe('Retry start ▾');
});

test('Start build is disabled with the hint while T3 has no project for the repository', async () => {
  const hint = 'No T3 project is a checkout of maddec01/lar-server; add the checkout in T3 Code';
  await mountPage({ ...readyBuild, repositoryProjects: { 'maddec01/lar-server': hint } });
  await openItem('I_sample13');
  expect(footerControls()).toEqual(['GitHub', `Start build (disabled: ${hint})`]);
});

test("Start build is disabled until onboarding's PR merges while the repository is still onboarding", async () => {
  await mountPage({ ...readyBuild, onboarding: [{ repo: 'maddec01/lar-server', progress: { step: 'pr', done: ['project'], answers: { projectId: 'p1' } } }] });
  await openItem('I_sample13');
  expect(footerControls()).toEqual(['GitHub', "Start build (disabled: Waits for onboarding to finish)"]);
});

test.each([['running'], ['needs you']] as const)('a Ready item with a %s thread offers Open thread instead of Start build', async (state) => {
  await mountPage(withThreads('I_sample13', [thread('live', state)], readyBuild));
  await openItem('I_sample13');
  expect(footerControls()).toEqual(['GitHub', 'Open thread']);
});

test('Back to List in the dialog shows the item in List, says so, and moves focus to Queue', async () => {
  holdPosts();
  await mountPage();
  await openItem('I_sample05');
  await press(button('back-to-list', 'I_sample05'));
  expect(text(button('back-to-list', 'I_sample05'))).toBe('Moving to List…');
  expect(posted()).toEqual([['/api/back-to-list', { itemId: 'I_sample05' }]]);
  await answer({ error: null, board: moved('I_sample05', 'List') });
  expect(text(toast())).toMatch(/^Moved #129 .* to List\. View item$/);
  expect(document.activeElement).toBe(button('queue', 'I_sample05'));
});

test('a failed Back to List is a toast, and focus goes back to Back to List', async () => {
  holdPosts();
  await mountPage();
  await openItem('I_sample05');
  await press(button('back-to-list', 'I_sample05'));
  await answer({ error: 'GitHub is down.' }, 502);
  expect(text(toast())).toMatch(/^Couldn't move #129 .* to List\. GitHub is down\.$/);
  expect(document.activeElement).toBe(button('back-to-list', 'I_sample05'));
});

test('Abandon in the dialog asks first, sets the item aside and says so, then closes its ticket only after its own confirm', async () => {
  holdPosts();
  const data: BoardData = { ...sample, capture: { enabled: true, session: 'session-1' } };
  await mountPage(data);
  await openItem('I_sample01');
  await press(button('abandon', 'I_sample01'));
  expect(text($('#abandon-dialog h2'))).toMatch(/#61/);
  await settle(() => $$<HTMLButtonElement>('#abandon-dialog [data-slot="modal-footer"] button')[1]!.click());
  expect(posted()).toEqual([['/api/abandon', { session: 'session-1', itemId: 'I_sample01' }]]);
  expect(text(button('abandon', 'I_sample01'))).toBe('Abandoning…');
  await answer({ error: null, board: without('I_sample01') });
  expect(text(toast())).toBe(`Set #61 ${sample.items[0]!.title} aside on this Mac.`);
  expect($('[data-item-dialog]'), 'the dialog closes').toBeNull();
  expect(text($('#abandon-dialog h2'))).toBe(`Close the ticket of #61 ${sample.items[0]!.title} too?`);
  expect(posted().map(([path]) => path), 'nothing closes the ticket before its confirm').toEqual(['/api/abandon']);
  const [keep, close] = $$<HTMLButtonElement>('#abandon-dialog [data-slot="modal-footer"] button');
  expect([text(keep), text(close)]).toEqual(['Keep it open', 'Close issue']);
  await settle(() => close!.click());
  expect(posted().at(-1)).toEqual(['/api/close-ticket', { itemId: 'I_sample01' }]);
  await answer({ error: null });
  expect(text(toast())).toBe(`Closed #61 ${sample.items[0]!.title} as "not planned".`);
});

test('keeping the ticket open after Abandon closes nothing', async () => {
  holdPosts();
  await mountPage({ ...sample, capture: { enabled: true, session: 'session-1' } });
  await openItem('I_sample01');
  await press(button('abandon', 'I_sample01'));
  await settle(() => $$<HTMLButtonElement>('#abandon-dialog [data-slot="modal-footer"] button')[1]!.click());
  await answer({ error: null, board: without('I_sample01') });
  await settle(() => $$<HTMLButtonElement>('#abandon-dialog [data-slot="modal-footer"] button')[0]!.click());
  await settle(() => vi.advanceTimersByTime(300));
  expect($('#abandon-dialog')).toBeNull();
  expect(posted().map(([path]) => path)).toEqual(['/api/abandon']);
});

test('a failed Abandon in the dialog is a toast, and focus goes back to Abandon', async () => {
  holdPosts();
  await mountPage();
  await openItem('I_sample01');
  await press(button('abandon', 'I_sample01'));
  await settle(() => $$<HTMLButtonElement>('#abandon-dialog [data-slot="modal-footer"] button')[1]!.click());
  await answer({ error: 'Could not abandon #61.' }, 502);
  expect(text(toast())).toMatch(/^Couldn't abandon #61 .*\. Could not abandon #61\.$/);
  expect(inDialog('.action-error'), 'no inline error').toBeNull();
  await settle(() => vi.advanceTimersByTime(20));
  expect(document.activeElement).toBe(button('abandon', 'I_sample01'));
});

test('in sample mode the dialog’s actions are disabled', async () => {
  await mountPage({ ...sample, capture: { enabled: false } as BoardData['capture'] });
  await openItem('I_sample01');
  for (const b of [button('queue', 'I_sample01'), button('abandon', 'I_sample01')]) expect([b.disabled, b.title]).toEqual([true, 'Disabled in sample mode']);
});

test('an item that leaves the board closes the dialog for good: its coming back later opens nothing', async () => {
  await mountPage();
  await openItem('I_sample13');
  const { useItemDialogStore } = await import('./item-dialog-store.ts');
  const { useBoardStore } = await import('../board/board-store.ts');
  await settle(() => useBoardStore.getState().receive(without('I_sample13')));
  expect(useItemDialogStore.getState().itemId).toBeNull();
  await settle(() => useBoardStore.getState().receive(sample));
  expect(dialog()).toBeNull();
});

test('closing the dialog clears the store, and Escape closes it', async () => {
  await mountPage();
  await openItem('I_sample13');
  const { useItemDialogStore } = await import('./item-dialog-store.ts');
  const popup = dialog()!;
  await settle(() => popup.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(useItemDialogStore.getState().itemId).toBeNull();
  expect(dialog()).toBeNull();
});

test('work that needs you shows why, posts each choice it offers and Clear, and sets the work aside through Abandon', async () => {
  holdPosts();
  const id = 'I_sample05';
  const reason = 'Its PR closed without merging.';
  await mountPage({ ...sample, capture: { enabled: true, session: 'session-1' },
    items: sample.items.map((i) => (i.id === id ? { ...i, status: 'Review', needsYou: { reason, offers: ['reopen-pr', 'replace-pr', 'set-aside'] } } : i)) });
  await openItem(id);
  expect(text(inDialog('[data-needs-you-reason] p'))).toBe(`Needs you: ${reason}`);
  expect($$('[data-needs-you-reason] button').map(text)).toEqual(['Reopen PR', 'Start a replacement build', 'Set aside', 'Clear']);
  await press($$<HTMLButtonElement>('[data-needs-you-reason] button')[0]!);
  expect(posted()).toEqual([['/api/needs-you', { itemId: id, choice: 'reopen-pr' }]]);
  await answer({ error: "Couldn't reopen the PR." }, 502);
  expect(text(inDialog('.action-error [role="alert"]'))).toBe("Couldn't reopen the PR.");
  await press($$<HTMLButtonElement>('[data-needs-you-reason] button')[3]!);
  expect(posted().at(-1)).toEqual(['/api/needs-you', { itemId: id, choice: 'clear' }]);
  await answer({ error: null });
  await press($$<HTMLButtonElement>('[data-needs-you-reason] button')[2]!);
  expect(text($('#abandon-dialog h2'))).toMatch(/^Abandon #129 /);
});

/** A Dependency on the server team blocking a build, its ticket read an hour before NOW as `kind`. */
function dependencyBlocker(kind: NonNullable<DependencyHold['observation']>['kind'], change: Partial<DependencyHold> = {}): Blocker {
  const hold: DependencyHold = { dependencyId: 'dep-1', revision: 3, owner: 'server team', need: 'An export endpoint', ticket: 'maddec01/lar-server#40',
    named: [{ reference: 'maddec01/lar-server#40', url: 'https://github.com/maddec01/lar-server/issues/40' }], evidence: 'The endpoint answers in staging', met: null, needsReview: false,
    observation: { subject: 'maddec01/lar-server#40', kind, detail: null, observedAt: '2026-10-21T09:00:00Z', lastGood: null }, ...change };
  return { number: 40, repo: 'maddec01/lar-server', state: hold.met ? 'closed' : 'open', title: hold.need, dependency: hold };
}
const withDependency = (blocker: Blocker): BoardData => ({ ...sample, capture: { enabled: true, session: 'session-1' },
  items: sample.items.map((i) => (i.id === 'I_sample13' ? { ...i, blockers: [blocker] } : i)) });
const dependencyRow = () => inDialog('[data-dependency="dep-1"]')!;

test('a Dependency shows its team, ticket, latest read and evidence, suggests Mark met once its ticket closed, and posts the mark', async () => {
  holdPosts();
  await mountPage(withDependency(dependencyBlocker('closed')));
  await openItem('I_sample13');
  expect(text(inDialog('[data-item-summary] > div'))).toContain('blocked by 1');
  expect(text(section('Dependencies').querySelector('[data-dependency-owner]'))).toBe('Dependency on server team · not met');
  expect(text(dependencyRow())).toContain('An export endpoint');
  expect(text(dependencyRow().querySelector('[data-dependency-read]'))).toBe('maddec01/lar-server#40 closed, read 1h ago');
  const ticket = dependencyRow().querySelector<HTMLAnchorElement>('[data-dependency-read] a')!;
  expect([text(ticket), ticket.href, ticket.target], 'its ticket opens in the browser').toEqual(['maddec01/lar-server#40', 'https://github.com/maddec01/lar-server/issues/40', '_blank']);
  expect(text(dependencyRow().querySelector('[data-dependency-evidence]'))).toBe('Evidence: The endpoint answers in staging');
  expect(text(dependencyRow().querySelector('[data-dependency-notice]'))).toBe('Its ticket maddec01/lar-server#40 is closed. Mark it met once the change is delivered.');
  expect(footerControls()).toEqual(['GitHub', 'Start after server team ▾']);
  expect(inDialog<HTMLButtonElement>('[data-start-after]')!.title).toBe('Starts by itself once you mark the Dependency on server team met');
  expect(dependencyRow().querySelector('button')!.getAttribute('aria-label')).toMatch(/^Mark the Dependency on server team met: #140 /);
  await press(dependencyRow().querySelector<HTMLButtonElement>('button')!);
  expect(posted()).toEqual([['/api/dependency-met', { itemId: 'I_sample13', dependencyId: 'dep-1', revision: 3, met: true }]]);
  await answer({ error: 'The Dependency dep-1 is at revision 4, not 3; read it again and retry.' }, 409);
  expect(text(inDialog('.action-error [role="alert"]'))).toBe('The Dependency dep-1 is at revision 4, not 3; read it again and retry.');
});

test('a Dependency with an open ticket suggests nothing, and one without a read or evidence says so', async () => {
  await mountPage(withDependency(dependencyBlocker('open', { evidence: '', observation: null })));
  await openItem('I_sample13');
  expect(text(dependencyRow().querySelector('[data-dependency-read]'))).toBe('maddec01/lar-server#40 not read yet');
  expect(text(dependencyRow().querySelector('[data-dependency-evidence]'))).toBe('No evidence agreed yet');
  expect(dependencyRow().querySelector('[data-dependency-notice]')).toBeNull();
});

test('a Dependency naming no ticket or PR says it is a handover only', async () => {
  await mountPage(withDependency(dependencyBlocker('open', { ticket: null, named: [], observation: null })));
  await openItem('I_sample13');
  expect(text(dependencyRow().querySelector('[data-dependency-read]'))).toBe('No ticket. Handover only.');
});

test("a Dependency whose read failed says how in words, beside the last read that answered", async () => {
  const lastGood = { kind: 'open' as const, observedAt: '2026-10-19T09:00:00Z' };
  await mountPage(withDependency(dependencyBlocker('access-lost', { observation: { subject: 'maddec01/lar-server#40', kind: 'access-lost', detail: 'HTTP 403',
    observedAt: '2026-10-21T09:00:00Z', lastGood } })));
  await openItem('I_sample13');
  expect(text(dependencyRow().querySelector('[data-dependency-read]'))).toBe('maddec01/lar-server#40 access lost, read 1h ago; last read open, 2d ago');
});

test('a met Dependency whose ticket changed since asks for a review, offers to clear the mark and no longer blocks', async () => {
  holdPosts();
  await mountPage(withDependency(dependencyBlocker('reopened', { met: { by: 'pedro', at: '2026-10-21T08:00:00Z' }, needsReview: true })));
  await openItem('I_sample13');
  expect(text(inDialog('[data-item-summary] > div'))).not.toContain('blocked by');
  expect(text(section('Dependencies').querySelector('[data-dependency-owner]'))).toBe('Dependency on server team · met, marked by pedro 2h ago');
  expect(text(dependencyRow().querySelector('[data-dependency-notice]'))).toBe('Its ticket maddec01/lar-server#40 changed to reopened after you marked it met. Review the mark.');
  const clear = dependencyRow().querySelector<HTMLButtonElement>('button')!;
  expect(text(clear)).toBe('Clear met mark');
  expect(clear.getAttribute('aria-label')).toMatch(/^Clear the met mark on the Dependency on server team: #140 /);
  await press(clear);
  expect(posted()).toEqual([['/api/dependency-met', { itemId: 'I_sample13', dependencyId: 'dep-1', revision: 3, met: false }]]);
});

test('work that needs nothing from you shows no reason', async () => {
  await mountPage();
  await openItem('I_sample05');
  expect(inDialog('[data-needs-you-reason]')).toBeNull();
});
