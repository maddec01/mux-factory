// Everything else in flight: the line's card of every item past the Queue and short of Done, each row on a collapsed
// dossier's two lines and line 2 columns, with its agent figures, a build's slices, and its side action. Ports the old
// Board view's in-flight cards and slice popover tests to the card.

import { beforeEach, expect, test, vi } from 'vite-plus/test';
import { $, $$, answer, holdPosts, mountPage, posted, pressMenu, recorded, sample, settle, text, toast } from '../../test/support.ts';
import { normalizeItems } from '@lar-factory/shared';
import type { BoardData, Item, ItemThread, RawItem, Slice } from '@lar-factory/shared';
import { rawIssue, sliceRef } from '@lar-factory/shared/test/raw-items';

const table = () => $('[data-in-flight]')!;
const rows = () => $$('[data-in-flight] [data-item]');
const row = (id: string) => $(`[data-in-flight] [data-item="${id}"]`)!;
const numberOf = (id: string) => sample.items.find((i) => i.id === id)!.number;
const meta = (id: string) => row(id).querySelector<HTMLElement>('[data-meta]')!;
const col = (id: string, name: string) => row(id).querySelector<HTMLElement>(`[data-col="${name}"]`)!;
const side = (id: string) => col(id, 'side');
const startBuild = (id = 'I_sample13') => $<HTMLButtonElement>(`[data-in-flight] [data-start="${id}"]`)!;
/** Clicks `el`; a menu it closes hands focus back on the next tick. */
const press = (el: Element) => settle(() => {
  (el as HTMLElement).click();
  vi.advanceTimersByTime(0);
});
const entries = () => $$('[role="menu"] [role="menuitemradio"]');
const dialog = () => $('[data-item-dialog]');
/** The board with `raws` as items, each open slice numbered in `keys` active or blocked, as its work record holds it. */
const boardOf = (raws: RawItem[], { active = [], blocked = [] }: { active?: number[]; blocked?: number[] } = {}): BoardData => {
  const progress = (slice: Slice): Slice => (slice.progress !== 'waiting' ? slice
    : { ...slice, progress: blocked.includes(slice.number) ? 'blocked' : active.includes(slice.number) ? 'active' : 'waiting' });
  const items = normalizeItems(raws).map((item) => ({ ...item, slices: item.slices.map(progress) }));
  return { ...sample, error: null, items: recorded(items) };
};
const withItem = (id: string, change: Partial<Item>, data: BoardData = sample): BoardData =>
  ({ ...data, items: data.items.map((i) => (i.id === id ? { ...i, ...change } : i)) });
/** The sample with #140 out of its concept's dossier, so it has a row in the table. */
const loose = withItem('I_sample13', { parent: null, parentId: null });
/** #140 with its blocker closed, so its Start build runs, on a board whose writes are on. */
const unblocked = (data: BoardData = loose): BoardData => withItem('I_sample13', {
  blockers: [{ number: 202, repo: 'maddec01/lar-server', state: 'closed' }],
}, { ...data, capture: { session: 's1', enabled: true }, modelChoices: [{ instanceId: 'codex', name: 'Codex', models: [{ slug: 'gpt-5.5', label: 'GPT-5.5' }] }] });
const thread = (id: string, state: ItemThread['state']): ItemThread => ({ id, title: `Thread ${id}`, state, updated: '2026-10-21T09:00:00.000Z' });

beforeEach(() => localStorage.clear());

test('the card lists everything past the Queue and short of Done that no dossier shows, furthest along first, under its title', async () => {
  await mountPage();
  expect(text(table().firstElementChild)).toBe('Everything else in flight · 11');
  expect(rows().map((r) => numberOf(r.dataset.item!)), 'Verify first, Refining last, in board order within a stage; #200 and #180 and their parts sit in dossiers')
    .toEqual([31, 900026, 34, 147, 142, 141, 150, 30, 130, 22, 23]);
  await settle(async () => (await import('../board/board-store.ts')).useBoardStore.getState().receive(loose));
  expect(rows().map((r) => numberOf(r.dataset.item!)), 'a part out of its dossier is back').toEqual([31, 900026, 34, 147, 142, 141, 150, 30, 140, 130, 22, 23]);
});

test('with nothing in flight, the table says so', async () => {
  await mountPage({ ...sample, items: sample.items.filter((i) => ['List', 'Queued', 'Done'].includes(i.status)) });
  expect(text(table())).toBe('Everything else in flight · 0Nothing else in flight.');
});

test('the table takes the main area\'s scope', async () => {
  await mountPage();
  const { useScopeStore } = await import('../board/scope-store.ts');
  await settle(() => useScopeStore.getState().setScope('maddec01/lar-apple'));
  expect(rows().map((r) => numberOf(r.dataset.item!))).toEqual([31, 34, 30, 22, 23]);
});

test("scoped to a repository whose items haven't landed yet, the main area says it's reading instead of an empty desk and line", async () => {
  await mountPage({ ...sample, items: sample.items.filter((i) => i.repo !== 'maddec01/lar-apple'),
    firstRead: { step: 'items', running: ['lar-apple'], waiting: ['maddec01/lar-apple'], settled: false } });
  const { useScopeStore } = await import('../board/scope-store.ts');
  await settle(() => useScopeStore.getState().setScope('maddec01/lar-apple'));
  expect(text($('[data-reading]'))).toBe('Reading lar-apple…');
  expect([table(), $('section.desk')]).toEqual([null, null]);
  await settle(() => useScopeStore.getState().setScope('maddec01/lar-server'));
  expect([$('[data-reading]'), table() !== null]).toEqual([null, true]);
});

test('line 1 shows the status glyph, the numbered title and muted meta: status, thread, repository, PR and a red badge while blocked', async () => {
  await mountPage(loose);
  const title = row('I_sample13').querySelector('[data-title]')!;
  expect([text(title), title.getAttribute('title')]).toEqual(['#140 Owner accounts', 'Owner accounts']);
  expect(row('I_sample13').querySelector('[data-glyph] svg'), 'the status glyph sits in the chevron\'s place').not.toBeNull();
  expect([...meta('I_sample13').children].map(text)).toEqual(['Ready · Run finished · lar-server', 'blocked by 1. Blocked by #202 until it completes']);
  expect(text(meta('I_sample13').querySelector('.sr-only')), 'what blocks it is read out, not only a hover title').toBe('. Blocked by #202 until it completes');
  expect(meta('I_sample13').lastElementChild!.outerHTML).toContain('danger');
  expect([...meta('I_sample14').children].map(text), 'a linked PR follows the repository').toEqual(['In progress · Thread running · lar-apple', 'PR #33 (draft)']);
});

test('no row has a coloured repository dot', async () => {
  await mountPage(loose);
  expect(table().querySelector('[class*="repo-tone"]')).toBeNull();
});

test('a long title wraps to two lines and is clamped after that', async () => {
  await mountPage(withItem('I_sample13', { title: 'Owner accounts with a title long enough to run past one line of the title column at the app\'s narrowest width' }, loose));
  const name = row('I_sample13').querySelector('[data-title]')!;
  expect(name.className.split(' ')).toEqual(expect.arrayContaining(['line-clamp-2']));
  expect(name.className.split(' ')).not.toContain('truncate');
});

test('the badge counts the blocked-by issues still open', async () => {
  await mountPage(withItem('I_sample13', { blockers: [
    { number: 202, repo: 'maddec01/lar-server', state: 'open' }, { number: 203, repo: 'maddec01/lar-server', state: 'closed' },
  ] }, loose));
  expect(text(meta('I_sample13'))).toContain('blocked by 1');
  await settle(async () => (await import('../board/board-store.ts')).useBoardStore.getState()
    .receive(withItem('I_sample13', { blockers: [] }, loose)));
  expect(meta('I_sample13').textContent, 'with no open issue listed, nothing blocks').not.toContain('blocked by');
  expect(text(startBuild())).toBe('Start build ▾');
});

test('a Dependency holds the badge until it is marked met, whatever its ticket shows, and the badge names it', async () => {
  const dependency = (met: boolean) => ({ number: 40, repo: 'maddec01/lar-server', state: met ? 'closed' as const : 'open' as const, title: 'An export endpoint',
    dependency: { dependencyId: 'dep-1', revision: 2, owner: 'server team', need: 'An export endpoint', ticket: 'maddec01/lar-server#40', named: [], evidence: '',
      met: met ? { by: 'pedro', at: '2026-10-21T08:00:00Z' } : null, needsReview: false,
      observation: { subject: 'maddec01/lar-server#40', kind: 'closed' as const, detail: null, observedAt: '2026-10-21T09:00:00Z', lastGood: null } } });
  await mountPage(withItem('I_sample13', { blockers: [dependency(false)] }, loose));
  const badge = [...meta('I_sample13').children].find((el) => text(el).startsWith('blocked by 1')) as HTMLElement;
  expect(badge.title).toBe('Blocked by the Dependency on server team until you mark it met');
  expect(text(badge.querySelector('.sr-only'))).toBe('. Blocked by the Dependency on server team until you mark it met');
  await settle(async () => (await import('../board/board-store.ts')).useBoardStore.getState()
    .receive(withItem('I_sample13', { blockers: [dependency(true)] }, loose)));
  expect(meta('I_sample13').textContent).not.toContain('blocked by');
});

test('every row keeps line 2 on the dossiers\' columns at every width, its side action across both lines in the last column', async () => {
  await mountPage(loose);
  const lines = (id: string) => row(id).querySelector<HTMLElement>('[data-line2]')!;
  const columns = (el: Element) => el.className.split(' ').filter((c) => c.includes('grid-cols-'));
  expect(columns(lines('I_sample13')), 'the same columns as a dossier\'s line 2, so the slice bar sits under the part bar')
    .toEqual(columns($('[data-dossier] [data-line="2"]')!));
  expect(row('I_sample13').querySelector('[data-line="1"]')!.className.split(' ')).toEqual(expect.arrayContaining(['col-span-3', 'lg:col-span-4']));
  expect(side('I_sample13').className.split(' '), 'below 1024 px, where the dossiers drop their last column, the action sits on line 1 above the figures')
    .toEqual(expect.arrayContaining(['col-start-4', 'row-start-1', 'lg:col-start-5', 'lg:row-span-2', 'self-center']));
  expect(side('I_sample13').className.split(' '), 'no column of its own past the dossiers\' four').not.toContain('col-start-5');
  expect([...lines('I_sample14').children].map((c) => (c as HTMLElement).dataset.col ?? (c as HTMLElement).dataset.line), 'a row with no slices keeps line 2')
    .toEqual(['1', 'side', 'bar', 'count', 'next', 'figures']);
  expect([text(col('I_sample14', 'bar')), text(col('I_sample14', 'count')), text(col('I_sample14', 'next'))]).toEqual(['', '', '']);
  expect(row('I_sample13').className.split(' ')).toEqual(expect.arrayContaining(['py-1.5', 'gap-y-1']));
});

test('the figures column shows agent time, tokens and cost on one line, or nothing before any thread worked on it', async () => {
  const stats = { agentMs: (3 * 60 + 20) * 60_000, wallMs: 70 * 60_000, tokens: 12_436_000, costUsd: 41.197 };
  let data = withItem('I_sample14', { stats }, loose);
  data = withItem('I_sample15', { stats: { agentMs: 45 * 60_000, tokens: 980 } }, data);
  data = withItem('I_sample16', { stats: { ...stats, costUsd: 41, frozen: true } }, data);
  data = withItem('I_sample07', { stats: 'unavailable' }, data);
  await mountPage(data);
  const figures = (id: string) => col(id, 'figures').firstElementChild as HTMLElement;
  expect([text(figures('I_sample14')), figures('I_sample14').title]).toEqual(['3h 20m · 12.4M · $41.20', 'Agent time · tokens · cost']);
  expect(text(figures('I_sample15')), 'nothing priced').toBe('45m · 980');
  expect(figures('I_sample16').title).toBe('Agent time · tokens · cost, as it stood at merge');
  expect([text(col('I_sample13', 'figures')), text(col('I_sample07', 'figures'))]).toEqual(['', '']);
});

test('a row opens the item dialog and stays marked while it shows', async () => {
  await mountPage(loose);
  await press(row('I_sample14'));
  expect(text(dialog()!.querySelector('[data-slot="modal-header"] h2'))).toBe('#30 Chapter markers in the scrubber');
  expect(row('I_sample14').className).toContain('ring-(--primary)');
  expect(row('I_sample15').className).not.toContain('ring-(--primary)');
});

test('the side says where the item waits on you, or shows its next action', async () => {
  await mountPage(loose);
  const say = (id: string) => [text(side(id)), [...side(id).querySelectorAll('button, a')].map((b) => text(b))];
  expect(say('I_sample16')).toEqual(['on your desk', []]);
  expect(say('I_sample17')).toEqual(['on your desk', []]);
  expect(say('I_sample11')).toEqual(['on your desk', []]);
  expect(say('I_sample07')).toEqual(['Open thread', ['Open thread']]);
  expect(say('I_sample14')).toEqual(['Open thread', ['Open thread']]);
  expect(say('I_sample15')).toEqual(['Open thread', ['Open thread']]);
  expect(say('I_sample13')).toEqual(['Start after #202 ▾', ['Start after #202 ▾']]);
  expect(meta('I_sample14').firstElementChild!.textContent, 'the thread moves to the meta').toContain('Thread running');
});

test('Start after on a blocked Ready row arms its start on the picked model, then reads Starts after until pressed again', async () => {
  const blocked = { ...loose, capture: { session: 's1', enabled: true }, modelChoices: unblocked().modelChoices };
  holdPosts(blocked);
  await mountPage(blocked);
  const after = () => side('I_sample13').querySelector<HTMLButtonElement>('[data-start-after]')!;
  await pressMenu(after());
  expect(dialog(), 'the menu opens without the dialog').toBeNull();
  await press(entries()[1]!);
  expect(posted()).toEqual([['/api/arm', { session: 's1', itemId: 'I_sample13', model: { instanceId: 'codex', model: 'gpt-5.5' } }]]);
  await answer({ error: null, board: { ...blocked, armed: { I_sample13: { model: { instanceId: 'codex', model: 'gpt-5.5' } } } } });
  expect([text(after()), after().getAttribute('aria-pressed')]).toEqual(['Starts after #202 ✓', 'true']);
  await press(after());
  expect(posted().at(-1)).toEqual(['/api/disarm', { session: 's1', itemId: 'I_sample13' }]);
  await answer({ error: null, board: { ...blocked, armed: {} } });
  expect(text(after())).toBe('Start after #202 ▾');
});

test("Start after names the last open blocker, another repository's without its owner, and its title and label name it in full", async () => {
  await mountPage(withItem('I_sample13', { blockers: [
    { number: 202, repo: 'maddec01/lar-server', state: 'open' }, { number: 12, repo: 'maddec01/lar-apple', state: 'open' },
  ] }, loose));
  const after = side('I_sample13').querySelector<HTMLButtonElement>('[data-start-after]')!;
  expect([text(after), after.title]).toEqual(['Start after lar-apple#12 ▾', 'Starts by itself once #202, maddec01/lar-apple#12 complete']);
  expect(after.getAttribute('aria-label')).toBe('Start #140 Owner accounts after maddec01/lar-apple#12');
});

test("a blocked build whose repository has no T3 project offers no Start after: Start build shows the project's hint", async () => {
  const hint = 'No T3 project is a checkout of maddec01/lar-server; add the checkout in T3 Code';
  await mountPage({ ...loose, repositoryProjects: { 'maddec01/lar-server': hint } });
  expect([startBuild().disabled, startBuild().title]).toEqual([true, hint]);
  expect(side('I_sample13').querySelector('[data-start-after]')).toBeNull();
});

test("a blocked build whose repository is still onboarding offers no Start after: Start build waits for onboarding's PR", async () => {
  await mountPage({ ...loose, onboarding: [{ repo: 'maddec01/lar-server', progress: { step: 'pr', done: ['project'], answers: { projectId: 'p1' } } }] });
  expect([startBuild().disabled, startBuild().title]).toEqual([true, "Waits for onboarding to finish"]);
  expect(side('I_sample13').querySelector('[data-start-after]')).toBeNull();
});

test('a start armed before its repository lost its T3 project still shows Starts after, so it can be disarmed', async () => {
  const hint = 'No T3 project is a checkout of maddec01/lar-server; add the checkout in T3 Code';
  const armed = { ...loose, capture: { session: 's1', enabled: true }, repositoryProjects: { 'maddec01/lar-server': hint },
    armed: { I_sample13: { model: { instanceId: 'codex', model: 'gpt-5.5' } } } };
  holdPosts(armed);
  await mountPage(armed);
  expect(startBuild(), 'a blocker holds it too, so Start after stands alone').toBeNull();
  const after = side('I_sample13').querySelector<HTMLButtonElement>('[data-start-after]')!;
  expect([text(after), after.getAttribute('aria-pressed')]).toEqual(['Starts after #202 ✓', 'true']);
  await press(after);
  expect(posted()).toEqual([['/api/disarm', { session: 's1', itemId: 'I_sample13' }]]);
  await answer({ error: null, board: { ...armed, armed: {} } });
  expect(side('I_sample13').querySelector('[data-start-after]'), 'once disarmed, none can be armed again').toBeNull();
});

test("a start the board ran by itself and that failed shows its error under the row, and dismissing it clears it", async () => {
  const failed = { ...unblocked(), armedErrors: { I_sample13: 'T3 is down.' } };
  holdPosts(failed);
  await mountPage(failed);
  const error = table().querySelector('[data-start-after-error="I_sample13"]')!;
  expect(text(error.querySelector('[role="alert"]'))).toBe('Start after failed: T3 is down.');
  await press(error.querySelector('button')!);
  expect(posted()).toEqual([['/api/disarm', { session: 's1', itemId: 'I_sample13' }]]);
});

test('Open thread on a row opens the latest thread, as an Open with the thread icon, without opening the dialog', async () => {
  await mountPage(withItem('I_sample14', { threads: [thread('t1', 'running')] }, withItem('I_sample15', { threads: [] })));
  const open = side('I_sample14').querySelector<HTMLAnchorElement>('[data-open-thread]')!;
  expect([open.getAttribute('href'), open.dataset.kind, open.className.includes('border-base-400/90'), Boolean(open.querySelector('[data-slot="icon"] .lucide-message-square-text'))])
    .toEqual(['t3code://threads/sample-environment/t1', 'open', true, true]);
  await press(open);
  expect(dialog()).toBeNull();
  const none = side('I_sample15').querySelector<HTMLButtonElement>('[data-open-thread]')!;
  expect([none.disabled, none.title, none.dataset.kind]).toEqual([true, 'No T3 thread has worked on this yet', 'open']);
});

test('a blocked Ready row shows only Start after, a Start with its icon, never a disabled Start build beside it', async () => {
  await mountPage(loose);
  expect(startBuild()).toBeNull();
  const after = side('I_sample13').querySelector<HTMLButtonElement>('[data-start-after]')!;
  expect([after.dataset.kind, Boolean(after.querySelector('[data-slot="icon"] svg'))]).toEqual(['start', true]);
});

test('Start build is disabled with the hint while T3 has no project for the repository', async () => {
  const hint = 'No T3 project is a checkout of maddec01/lar-server; add the checkout in T3 Code';
  await mountPage({ ...unblocked(), repositoryProjects: { 'maddec01/lar-server': hint, 'maddec01/lar-apple': null } });
  expect([startBuild().disabled, startBuild().title, startBuild().dataset.kind]).toEqual([true, hint, 'start']);
  expect(startBuild().className, 'pointer events stay on, so the title shows').toContain('disabled:pointer-events-auto');
  await settle(async () => (await import('../board/board-store.ts')).useBoardStore.getState()
    .receive({ ...unblocked(), repositoryProjects: { 'maddec01/lar-server': null } }));
  expect([startBuild().disabled, text(startBuild())], 'a found project enables it').toEqual([false, 'Start build ▾']);
});

test.each(['running', 'needs you'] as const)('Open thread takes Start build\'s place while the item has a %s thread', async (state) => {
  await mountPage(withItem('I_sample13', { threads: [thread('t1', state)] }, unblocked()));
  expect(startBuild()).toBeNull();
  expect(side('I_sample13').querySelector('[data-open-thread]')!.getAttribute('href')).toBe('t3code://threads/sample-environment/t1');
});

test('a done thread leaves Start build', async () => {
  await mountPage(withItem('I_sample13', { threads: [thread('t1', 'done')] }, unblocked()));
  expect(text(startBuild())).toBe('Start build ▾');
});

test('Start build sends the build with the chosen model, then shows the thread it started in a tag and a toast', async () => {
  holdPosts(unblocked());
  await mountPage(unblocked());
  await pressMenu(startBuild());
  expect(dialog(), 'the menu opens without the dialog').toBeNull();
  expect(entries().map(text)).toEqual(['T3 default', 'GPT-5.5']);
  await press(entries()[1]!);
  expect(dialog(), 'picking an entry does not open the dialog').toBeNull();
  expect(posted()).toEqual([['/api/start-build', { session: 's1', itemId: 'I_sample13', model: { instanceId: 'codex', model: 'gpt-5.5' } }]]);
  expect([text(startBuild()), startBuild().getAttribute('aria-disabled')]).toEqual(['Starting…', 'true']);
  const started = { threadId: 'thread-1', title: 'Build maddec01/lar-server#140' };
  await answer({ thread: started, error: null });
  const tag = row('I_sample13').querySelector('[data-start-result]')!;
  expect([text(tag), tag.getAttribute('title')]).toEqual(['Started', 'T3 thread thread-1']);
  expect(startBuild()).toBeNull();
  expect(text(toast())).toBe('Build started for #140. Open thread');
  expect(JSON.parse(localStorage.getItem('lar-board:model-choice')!)).toEqual({ instanceId: 'codex', model: 'gpt-5.5' });
});

test('a failed Start build shows its error under the row and offers Retry start; closing the error brings Start build back', async () => {
  holdPosts(unblocked());
  await mountPage(unblocked());
  await pressMenu(startBuild());
  await press(entries()[0]!);
  expect(posted()).toEqual([['/api/start-build', { session: 's1', itemId: 'I_sample13' }]]);
  await answer({ thread: null, error: 'T3 is down.' }, 502);
  expect(text(startBuild())).toBe('Retry start ▾');
  const message = row('I_sample13').parentElement!.querySelector('p.start')!;
  expect(text(message.querySelector('[role="alert"]'))).toBe('T3 is down.');
  await press(message.querySelector('button.dismiss')!);
  expect(row('I_sample13').parentElement!.querySelector('p.start')).toBeNull();
  expect(text(startBuild())).toBe('Start build ▾');
  expect(dialog(), 'closing the error does not open the dialog').toBeNull();
});

test('a Start build that may have run hides Start build; closing its message leaves a tag', async () => {
  holdPosts(unblocked());
  await mountPage(unblocked());
  await pressMenu(startBuild());
  await press(entries()[0]!);
  await answer({ thread: null, uncertain: true, error: 'Check T3.' });
  expect(startBuild()).toBeNull();
  const message = row('I_sample13').parentElement!.querySelector<HTMLElement>('p.start[data-start-result]')!;
  expect(text(message.querySelector('[role="alert"]'))).toBe('Check T3.');
  await press(message.querySelector('button.dismiss')!);
  expect(text(row('I_sample13').querySelector('.started-tag.unsure'))).toBe('May have started');
});

test('a thread Start refining opened this board run is not taken for the build\'s', async () => {
  await mountPage({ ...unblocked(), started: { I_sample13: { threadId: 'shaping-1', title: 'Shape #140' } } });
  expect(text(startBuild())).toBe('Start build ▾');
});

test('in sample mode, Start build opens its menu and no entry starts anything', async () => {
  holdPosts();
  await mountPage({ ...unblocked(), capture: { session: 's', enabled: false } });
  expect(startBuild().disabled).toBe(false);
  await pressMenu(startBuild());
  expect(entries().every((e) => e.getAttribute('aria-disabled') === 'true' && e.title === 'Disabled in sample mode')).toBe(true);
  await press(entries()[1]!);
  expect(posted()).toEqual([]);
});

// A build's slices.

const build = (count: number) => rawIssue('I_build', 59, 'In progress', ['build'], {
  subIssuesSummary: { total: count, completed: 1 },
  subIssues: { nodes: Array.from({ length: count }, (_, i) => sliceRef(100 + i, i ? 'OPEN' : 'CLOSED')) },
});
/** The build row's slice bar segments' colours, its count button's text and its first blocked or active slice. */
const slices = (id = 'I_59') => {
  const bar = col(id, 'bar').querySelector('ol')!;
  return { segments: [...bar.children].map((li) => (li as HTMLElement).style.background), count: text(count(id)), next: text(col(id, 'next')) };
};
const count = (id = 'I_59') => row(id).querySelector<HTMLButtonElement>('button[data-col="count"]')!;
const list = (id = 'I_59') => $(`[data-flight="${id}"] [data-slices] ul`);

test('a build shows its slice bar and its count, naming the first blocked slice plus how many more are blocked or active', async () => {
  const raw = rawIssue('I_build', 59, 'In progress', ['build'], {
    subIssuesSummary: { total: 5, completed: 1 },
    subIssues: { nodes: [sliceRef(65, 'CLOSED'), sliceRef(66, 'OPEN'), sliceRef(67, 'OPEN'), sliceRef(68, 'OPEN'), sliceRef(69, 'OPEN')] },
  });
  await mountPage(boardOf([raw], { active: [66, 67, 69], blocked: [67, 69] }));
  expect(slices()).toEqual({
    segments: ['var(--st-done)', 'var(--st-now)', 'var(--st-review)', 'var(--soft)', 'var(--st-review)'],
    count: '1/5 slices', next: 'blocked Issue 67 +2 more',
  });
  expect(col('I_59', 'next').firstElementChild!.className, 'blocked reads in its colour').toContain('text-(--st-review)');
  expect(col('I_59', 'next').getAttribute('title'), 'the rest are named on hover').toBe('blocked #67 Issue 67\nblocked #69 Issue 69\nactive #66 Issue 66');
  expect(col('I_59', 'bar').querySelector('ol > li.status-pulse'), 'the active slice pulses').not.toBeNull();
  expect(rows().map((r) => r.dataset.item), 'slices are no rows of their own').toEqual(['I_59']);
  await press(count());
  expect([...list()!.querySelectorAll('li')].map((li) => text(li).slice(0, 3)), 'the list shows every slice').toEqual(['#65', '#66', '#67', '#68', '#69']);
});

test('with none blocked, a build names its first active slice, and no more when it is the only one', async () => {
  const raw = rawIssue('I_build', 59, 'In progress', ['build'], {
    subIssuesSummary: { total: 3, completed: 1 },
    subIssues: { nodes: [sliceRef(65, 'CLOSED'), sliceRef(66, 'OPEN'), sliceRef(67, 'OPEN')] },
  });
  await mountPage(boardOf([raw], { active: [66, 67] }));
  expect([slices().count, slices().next]).toEqual(['1/3 slices', 'active Issue 66 +1 more']);
  await settle(async () => (await import('../board/board-store.ts')).useBoardStore.getState().receive(boardOf([raw], { active: [67] })));
  expect([slices().count, slices().next]).toEqual(['1/3 slices', 'active Issue 67']);
});

test('a build\'s count leaves out slices closed as not planned, and names none while none is active or blocked', async () => {
  const raw = rawIssue('I_build', 59, 'In progress', ['build'], {
    subIssuesSummary: { total: 4, completed: 2 },
    subIssues: { nodes: [sliceRef(65, 'CLOSED'), { ...sliceRef(66, 'CLOSED'), stateReason: 'NOT_PLANNED' }, sliceRef(67, 'OPEN'), sliceRef(68, 'OPEN')] },
  });
  await mountPage(boardOf([raw]));
  expect(slices()).toEqual({ segments: ['var(--st-done)', 'var(--soft)', 'var(--soft)'], count: '1/3 slices', next: '' });
});

test('an open slice the project auto-added is no row of its own', async () => {
  const slice = rawIssue('I_slice66', 66, 'In progress', ['improvement'], {
    parent: { number: 59, title: 'Issue 59', url: 'https://github.com/maddec01/lar-factory/issues/59', state: 'OPEN', repository: { nameWithOwner: 'maddec01/lar-factory' } },
  });
  const raw = rawIssue('I_build', 59, 'In progress', ['build'], {
    subIssuesSummary: { total: 3, completed: 1 }, subIssues: { nodes: [sliceRef(65, 'CLOSED'), sliceRef(66, 'OPEN'), sliceRef(67, 'OPEN')] },
  });
  await mountPage(boardOf([slice, raw, rawIssue('I_other', 70, 'In progress', ['bug'])]));
  expect(rows().map((r) => r.dataset.item)).toEqual(['I_59', 'I_70']);
});

test('the count unfolds the slice list under the row and folds it again, without opening the dialog', async () => {
  await mountPage(loose);
  expect([count('I_sample13').getAttribute('aria-expanded'), count('I_sample13').getAttribute('aria-label'), list('I_sample13')]).toEqual(['false', 'Show slices', null]);
  await press(count('I_sample13'));
  expect([count('I_sample13').getAttribute('aria-expanded'), count('I_sample13').getAttribute('aria-label')]).toEqual(['true', 'Hide slices']);
  expect([...list('I_sample13')!.querySelectorAll('li')].map(text)).toEqual(['#144Owner table and sign-updone', '#145Sign-in sessionsactive', '#146Owner settings pagewaiting']);
  expect(dialog()).toBeNull();
  await settle(async () => (await import('../board/board-store.ts')).useBoardStore.getState().receive({ ...loose, fetchedAt: '2026-10-21T09:59:00.000Z' }));
  expect(list('I_sample13'), 'new data keeps it open').not.toBeNull();
  await press(count('I_sample13'));
  expect(list('I_sample13')).toBeNull();
});

test('a 3-slice and a 14-slice build render the same row structure', async () => {
  // Tags only, with the slice bar's segments dropped.
  const shape = () => {
    const copy = row('I_59').cloneNode(true) as Element;
    copy.querySelectorAll('[data-col="bar"] ol > li').forEach((li) => li.remove());
    return [...copy.querySelectorAll('*')].map((e) => `${e.tagName}.${e.className}`).join(' ');
  };
  await mountPage(boardOf([build(14)], { active: [101, 102] }));
  const many = shape();
  await settle(async () => (await import('../board/board-store.ts')).useBoardStore.getState().receive(boardOf([build(3)], { active: [101, 102] })));
  expect(shape()).toBe(many);
});

test.each(['Shaping', 'In progress', 'Review'] as const)('line activity follows the latest real thread at %s', async (status) => {
  const id = 'I_sample14';
  const data = withItem(id, { status, threads: [] });
  await mountPage(data);
  const activity = () => text(meta(id).firstElementChild).split(' · ')[1];
  expect(activity()).toBe('Not started');
  const { useBoardStore } = await import('../board/board-store.ts');
  for (const [state, expected] of [['running', 'Thread running'], ['stopped', 'Run stopped'], ['done', 'Run finished'], ['needs you', 'Thread needs you']] as const) {
    await settle(() => useBoardStore.getState().receive(withItem(id, { status, threads: [thread('t1', state)] })));
    expect(activity()).toBe(expected);
  }
  await settle(() => useBoardStore.getState().receive(withItem(id, { status, threads: 'unavailable' })));
  expect(activity()).toBe('Thread unavailable');
  await settle(() => useBoardStore.getState().receive(withItem(id, { status, threads: [{ ...thread('t1', 'running'), observedAt: '2026-10-21T09:05:00.000Z' }] })));
  expect(activity()).toMatch(/^Thread running, last seen \d\d:05$/);
});

test('a stopped build replaces its remembered Started tag with recovery, also in the item dialog', async () => {
  const data = unblocked();
  holdPosts(data);
  await mountPage(data);
  await pressMenu(startBuild());
  await press(entries()[0]!);
  const started = { threadId: 'stopped-build', title: 'Build maddec01/lar-server#140' };
  await answer({ thread: started, error: null });
  const { useBoardStore } = await import('../board/board-store.ts');
  await settle(() => useBoardStore.getState().receive(withItem('I_sample13', { threads: [thread('newer-shaping', 'stopped'), thread('stopped-build', 'stopped')] }, {
    ...data, startedBuilds: { I_sample13: started },
  })));
  expect(text(side('I_sample13'))).toContain('Run stopped.');
  expect(side('I_sample13').querySelector('[data-start-result]')).toBeNull();
  expect(side('I_sample13').querySelector('[data-open-thread]')!.getAttribute('href')).toBe('t3code://threads/sample-environment/stopped-build');
  await press(row('I_sample13'));
  expect(text(dialog()!.querySelector('[data-slot="modal-footer"]'))).toContain('Run stopped.');
  expect(dialog()!.querySelector('[data-open-thread]')!.getAttribute('href')).toBe('t3code://threads/sample-environment/stopped-build');
  const again = side('I_sample13').querySelector<HTMLButtonElement>('[data-start]')!;
  expect(text(again)).toBe('Start again ▾');
  expect(text(dialog()!.querySelector('[data-start]'))).toBe('Start again ▾');
  await pressMenu(again);
  await press(entries()[0]!);
  expect(posted()).toHaveLength(2);
  expect(text(startBuild())).toBe('Starting…');
  await answer({ thread: { threadId: 'new-build', title: 'Build again' }, error: null,
    board: { ...data, startedBuilds: { I_sample13: { threadId: 'new-build', title: 'Build again' } } } });
  expect(text(side('I_sample13').querySelector('[data-start-result]'))).toBe('Started');
});

test.each([false, true])('a Ready item keeps Start build after shaping stops (recorded: %s)', async (recorded) => {
  const shaping = thread('stopped-shaping', 'stopped');
  await mountPage(withItem('I_sample13', { threads: [shaping] }, {
    ...unblocked(), started: recorded ? { I_sample13: { threadId: shaping.id, title: shaping.title } } : {},
  }));
  expect(text(startBuild())).toBe('Start build ▾');
  expect(text(side('I_sample13'))).not.toContain('Run stopped.');
  await press(row('I_sample13'));
  expect(text(dialog()!.querySelector('[data-slot="modal-footer"]'))).toContain('Start build ▾');
});
