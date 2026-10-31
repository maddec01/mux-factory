// The line's dossiers: each open concept, and each open item with sub-issues on the board: its two header lines,
// collapsed until opened, then what keeps the work moving and its parts as a Work map or a list. Ports the old Board
// view's concept block tests.

import { beforeEach, expect, test, vi } from 'vite-plus/test';
import { $, $$, answer, holdPosts, mountPage, posted, pressMenu, recorded, sample, settle, text } from '../../test/support.ts';
import { normalizeItems } from '@lar-factory/shared';
import type { BoardData, DependencyHold, Item, ItemThread } from '@lar-factory/shared';
import { rawIssue, sliceRef } from '@lar-factory/shared/test/raw-items';

const C200 = 'I_sample09';
const C180 = 'I_sample23';
const dossier = (id = C200) => $(`[data-dossier="${id}"]`)!;
const header = (id = C200) => dossier(id).firstElementChild as HTMLElement;
const line = (n: 1 | 2, id = C200) => header(id).querySelector<HTMLElement>(`[data-line="${n}"]`)!;
/** Line 2's "what's next": the part that waits on you, the first part that can start, or the fallback. */
const next = (id = C200) => header(id).querySelector<HTMLElement>('[data-next]')!;
const chips = (id = C200) => [...header(id).querySelectorAll('[data-chip]')].map(text);
const toggle = (id = C200) => header(id).querySelector<HTMLButtonElement>('[aria-expanded]')!;
const OPEN_KEY = 'lar-board:dossier-open:';
const VIEW_KEY = 'lar-board:dossier-view:';
const step = (id: string, d = C200) => dossier(d).querySelector<HTMLElement>(`[data-part="${id}"]`)!;
/** The parts the parts list shows, in its order. */
const listed = (d = C200) => [...dossier(d).querySelectorAll<HTMLElement>('[data-parts-list] [data-part]')].map((p) => p.dataset.part);
const startIn = (el: Element) => el.querySelector<HTMLButtonElement>('[data-start]');
/** Clicks `el`; a menu it closes hands focus back on the next tick. */
const press = (el: Element) => settle(() => {
  (el as HTMLElement).click();
  vi.advanceTimersByTime(0);
});
const entries = () => $$('[role="menu"] [role="menuitemradio"]');
const dialogTitle = () => text($('[data-item-dialog] [data-slot="modal-header"] h2'));
const button = (within: Element, label: string) => [...within.querySelectorAll<HTMLButtonElement>('button')].find((b) => text(b) === label)!;
const withItem = (id: string, change: Partial<Item>, data: BoardData = sample): BoardData =>
  ({ ...data, items: data.items.map((i) => (i.id === id ? { ...i, ...change } : i)) });
const writable = (data: BoardData = sample): BoardData =>
  ({ ...data, capture: { session: 's1', enabled: true }, modelChoices: [{ instanceId: 'codex', name: 'Codex', models: [{ slug: 'gpt-5.5', label: 'GPT-5.5' }] }] });
/** #140 with its blocker #202 closed, on a board whose writes are on. */
const unblocked = () => writable(withItem('I_sample13', { blockers: [{ number: 202, repo: 'maddec01/lar-server', state: 'closed' }] }));
const c200 = sample.items.find((i) => i.id === C200)!;
/** A Queued grill under #200, blocked by `blockers`. */
const decision = (blockers: Item['blockers'] = []): Item => ({
  ...sample.items.find((i) => i.id === 'I_sample05')!, id: 'I_d204', number: 204, title: 'Pick the relay host', labels: ['decision-grill'],
  repo: c200.repo, parent: { number: 200, repo: c200.repo!, title: c200.title, url: c200.url!, state: 'open' }, parentId: c200.id,
  blockers,
});
const withDecision = (blockers?: Item['blockers']) => writable({ ...sample, items: [...sample.items, decision(blockers)] });
const receive = (data: BoardData) => settle(async () => (await import('../board/board-store.ts')).useBoardStore.getState().receive(data));
const thread = (id: string, state: ItemThread['state']): ItemThread => ({ id, title: `Thread ${id}`, state, updated: '2026-10-21T09:00:00.000Z' });

/** Every sample dossier starts open on its parts list here, so the tests of a dossier's body see it; the collapsed
 *  and Work map tests clear this. */
beforeEach(() => {
  localStorage.clear();
  for (const id of [C200, C180, 'I_100', 'I_700']) {
    localStorage.setItem(OPEN_KEY + id, '1');
    localStorage.setItem(VIEW_KEY + id, 'list');
  }
});

test('each open concept and item with sub-issues on the board is a dossier, in board order, between the Queue and the rest of the line', async () => {
  await mountPage();
  expect([...$('.line > div')!.children].map((el) => el.className.split(' ')[0])).toEqual(['queue', 'grid', 'overflow-hidden']);
  const list = $('[data-dossiers]')!;
  expect([[...list.children].map((el) => el.getAttribute('data-dossier')), list.className.split(' ')], 'the dossiers sit 8 px apart')
    .toEqual([[C200, C180], expect.arrayContaining(['gap-2'])]);
  await receive({ ...sample, items: sample.items.filter((i) => !i.labels.includes('concept') && i.parent?.number !== 180) });
  expect([$$('[data-dossier]'), $('[data-dossiers]')], 'none without a concept or a parent').toEqual([[], null]);
});

test('a dossier starts collapsed to its two header lines, and the browser remembers it opened across a reload', async () => {
  localStorage.clear();
  await mountPage();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  expect([toggle().getAttribute('aria-expanded'), dossier().children.length, dossier().querySelector('[data-work-map]')]).toEqual(['false', 1, null]);
  await press(line(2));
  expect([toggle().getAttribute('aria-expanded'), localStorage.getItem(OPEN_KEY + C200)]).toEqual(['true', '1']);
  expect(dossier().querySelector('[data-work-map]'), 'opened, it shows its body').not.toBeNull();
  vi.resetModules();
  await mountPage();
  expect([toggle().getAttribute('aria-expanded'), toggle(C180).getAttribute('aria-expanded')], 'the others stay collapsed').toEqual(['true', 'false']);
  await press(toggle());
  expect([dossier().children.length, localStorage.getItem(OPEN_KEY + C200)]).toEqual([1, '0']);
});

test('only the title opens the item; anywhere else on the header but the chips opens or closes the dossier', async () => {
  localStorage.clear();
  await mountPage();
  await press(header().querySelector('[data-title]')!);
  expect([dialogTitle(), toggle().getAttribute('aria-expanded')]).toEqual(['#200 lar cloud: website sign-in and relay', 'false']);
  await press($('[data-item-dialog] [aria-label="Close"]') ?? document.body);
  for (const el of [line(1), line(2)]) {
    const was = toggle().getAttribute('aria-expanded');
    await press(el);
    expect(toggle().getAttribute('aria-expanded'), el.outerHTML.slice(0, 40)).not.toBe(was);
  }
  const was = toggle().getAttribute('aria-expanded');
  await press(header().querySelector('[data-chips]')!);
  expect(toggle().getAttribute('aria-expanded'), 'a chip leaves it as it was').toBe(was);
  await press(next());
  expect([dialogTitle(), toggle().getAttribute('aria-expanded')], "what's next opens no dialog; it toggles the dossier").toEqual(['', was === 'true' ? 'false' : 'true']);
});

/** A pointer click (`detail` 1) or a key press's click (`detail` 0) on `el`. */
const clickWith = (el: Element, detail: number) => settle(() => {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail }));
});
/** Selects the text of `el`. */
const select = (el: Element) => {
  const range = document.createRange();
  range.selectNodeContents(el);
  window.getSelection()!.removeAllRanges();
  window.getSelection()!.addRange(range);
};

test('letting go of a drag that selected text in the header leaves the dossier as it was', async () => {
  localStorage.clear();
  await mountPage();
  select(line(2));
  await clickWith(line(2), 1);
  expect(toggle().getAttribute('aria-expanded')).toBe('false');
  window.getSelection()!.removeAllRanges();
  await clickWith(line(2), 1);
  expect(toggle().getAttribute('aria-expanded')).toBe('true');
});

test('a selection elsewhere never stops the dossier toggling, nor does one in the header stop a key press on the chevron', async () => {
  localStorage.clear();
  await mountPage();
  select(header(C180));
  await clickWith(line(2), 1);
  expect(toggle().getAttribute('aria-expanded'), 'a click, with text selected in another dossier').toBe('true');
  select(line(2));
  await clickWith(toggle(), 0);
  expect(toggle().getAttribute('aria-expanded'), 'Enter or Space on Collapse, with text selected in the header').toBe('false');
  window.getSelection()!.removeAllRanges();
});

test('line 1 holds the kind, the full title, its T3 threads, and chips that hide at zero', async () => {
  await mountPage();
  const title = header().querySelector('[data-title]')!;
  expect([text(line(1).firstElementChild!.firstElementChild!.firstElementChild), text(title)]).toEqual(['Concept', '#200 lar cloud: website sign-in and relay']);
  expect(title.className.split(' '), 'the title wraps, never truncates').not.toContain('truncate');
  expect(text(header().querySelector('[data-threads]'))).toBe('4 T3 threads · 1 running · 1 awaiting your reply');
  expect(chips(), 'parts in Needs you, open decisions and the fog left').toEqual(['1 need you', '2 decisions', '2 fog']);
  expect([text(line(1, C180).firstElementChild!.firstElementChild!.firstElementChild), chips(C180)]).toEqual(['Coupled work', []]);
  expect(text(header(C180).querySelector('[data-threads]')), 'a zero count is left out').toBe('3 T3 threads · 1 running');
  await receive({ ...sample, items: sample.items.map((i) => ({ ...i, threads: [] })) });
  const none = header().querySelector('[data-threads]')!;
  expect([none.textContent, none.className.split(' ').includes('empty:hidden'), none.getAttribute('title')], 'with no threads, nothing: never "0 T3 threads"').toEqual(['', true, null]);
});

test('line 1 stays one row: its threads and Azure fields give up their room to an ellipsis, the title keeps its own and the chips theirs', async () => {
  await mountPage(withItem(C200, { azure: { type: 'Feature', state: 'Active', assignee: 'Ana' } }));
  const [meta, chipsEl] = [...line(1).children] as HTMLElement[];
  const classes = (el: Element) => el.className.split(' ');
  expect(classes(meta!), 'nothing on line 1 wraps onto a row of its own').not.toContain('flex-wrap');
  const [title, threads, azure] = [...meta!.children] as HTMLElement[];
  expect(classes(title!), 'the badge and title shrink last').not.toContain('shrink-[1000]');
  expect(header().querySelector('[data-title]')!.className.split(' '), 'the title is only as wide as its text').not.toContain('flex-1');
  for (const el of [threads!, azure!]) {
    expect(classes(el)).toEqual(expect.arrayContaining(['shrink-[1000]', 'truncate']));
    expect(classes(el), 'a stub floor only from lg up, so a narrow line gives the title its room')
      .toEqual(expect.arrayContaining(['min-w-0', 'lg:min-w-10']));
    expect(classes(el)).not.toContain('min-w-10');
  }
  expect([threads!.title, azure!.querySelector('[data-azure]')!.getAttribute('title')], 'each keeps its full text in a tooltip')
    .toEqual(['4 T3 threads · 1 running · 1 awaiting your reply', 'Feature · Active · Ana']);
  expect(classes(chipsEl!)).toContain('shrink-0');
});

test('the blocked chip counts the blocked slices of unfinished parts', async () => {
  const s13 = sample.items.find((i) => i.id === 'I_sample13')!;
  await mountPage(withItem('I_sample13', { slices: s13.slices.map((x, n) => (n < 2 ? { ...x, progress: 'blocked' as const } : x)) }));
  expect(chips()).toContain('2 blocked');
});

const col = (name: string, id = C200) => line(2, id).querySelector<HTMLElement>(`[data-col="${name}"]`)!;

test("line 2 has the part bar, parts done, what's next, agent figures and repositories in the same fixed columns in every dossier", async () => {
  await mountPage();
  const grid = (id: string) => line(2, id).className.split(' ').filter((c) => c.includes('grid-cols'));
  expect(grid(C200)).toEqual(['grid-cols-[18rem_5.5rem_minmax(0,1fr)_9.5rem]', 'lg:grid-cols-[18rem_5.5rem_minmax(0,1fr)_9.5rem_9rem]']);
  expect(grid(C180)).toEqual(grid(C200));
  expect([...line(2).children].map(text)).toEqual(['', '2/6 parts', 'Needs you#202 Sign-in screen', '1h 31m · 6.23M · $9.11', 'lar-server']);
  expect(col('bar').querySelectorAll('[data-part-bar] li').length, 'a segment per part').toBe(6);
  expect(next().querySelector('[title]')!.className.split(' '), "what's next ends in an ellipsis").toContain('truncate');
  expect(col('repos').className.split(' '), 'repositories are muted text that drops below 1024 px').toEqual(expect.arrayContaining(['hidden', 'lg:block', 'text-(--muted-foreground)']));
  expect([text(line(2, C180).children[1]), text(next(C180)), text(col('repos', C180))]).toEqual(['2/2 parts', 'Nothing waits on you', 'lar-server + lar-apple']);
  expect(next(C180).querySelector('[title]')!.getAttribute('title'), 'its cut-off text reads in full in a tooltip').toBe('Nothing waits on you');
});

test('the header has no stage track and no repository dots; the agent figures sit on one line, and nothing shows without them', async () => {
  await mountPage(withItem(C200, { azure: { type: 'Feature', state: 'Active', assignee: 'Ana' } }));
  expect([header().querySelector('[data-figures]'), header().querySelector('[class*="rounded-full"]:not([data-part-bar] li)')]).toEqual([null, null]);
  expect(header().children.length, 'the chevron, line 1 and line 2').toBe(3);
  const figures = col('figures').firstElementChild!;
  expect([figures.children.length, text(figures), figures.className.split(' ')], "#200's parts' figures, one truncating line").toEqual([0, '1h 31m · 6.23M · $9.11', expect.arrayContaining(['truncate'])]);
  expect(text(line(1).querySelector('[data-azure]'))).toBe('Feature · Active · Ana');
  await receive({ ...sample, items: sample.items.map((i) => ({ ...i, stats: undefined })) });
  expect(text(col('figures')), 'no figures, an empty column').toBe('');
});

test('a concept keeps the provider counts when Reset hides an unfinished part', async () => {
  const data = withItem(C180, { subIssues: { total: 2, completed: 1 } });
  await mountPage({ ...data, repos: data.repos.filter((r) => r.repo !== 'maddec01/lar-apple'),
    items: data.items.filter((i) => i.repo !== 'maddec01/lar-apple') });
  expect(text(line(2, C180).children[1])).toBe('1/2 parts');
  expect(text(dossier(C180))).toContain("1 part the board doesn't read");
  expect(text(next(C180))).not.toContain('Nothing waits on you');
  await press(button(dossier(C180), 'Work map'));
  expect(text(dossier(C180))).toContain("1 part the board doesn't read");
});

test('an open dossier has no About section; what keeps the work moving is in labelled rows, each with its entries', async () => {
  await mountPage();
  expect(dossier().querySelector('[data-about]')).toBeNull();
  expect(text(dossier())).not.toContain('Destination');
  const rows = () => [...dossier().querySelectorAll<HTMLElement>('[data-attention-row]')];
  expect(rows().map((r) => [r.dataset.attentionRow, text(r.firstElementChild)])).toEqual([
    ['you', 'Needs you 1'], ['decisions', 'Open decisions 2'], ['waiting', 'Waiting 1'], ['fog', 'Fog 2'],
  ]);
  const entries = (key: string) => [...dossier().querySelector(`[data-attention-row="${key}"] dd`)!.children].map(text);
  expect(entries('decisions')).toEqual(['#202 Sign-in screenprototype · Needs you', '#201 Relay: broker only or full TURN?grill · Shaping']);
  expect(entries('waiting')).toEqual(['#140 Owner accountswaits on #202']);
  expect(entries('fog'), "the map's fog questions").toEqual(c200.map!.fog);
  await press(button(dossier().querySelector('[data-attention-row="you"]')!, '#202 Sign-in screen'));
  expect(dialogTitle(), 'a part opens its item').toBe('#202 Sign-in screen');
  await press($('[data-item-dialog] [aria-label="Close"]')!);
  await press(button(dossier().querySelector('[data-attention-row="fog"]')!, '#201'));
  expect(dialogTitle(), "a fog question's #n opens its item").toBe(`#201 ${sample.items.find((i) => i.number === 201)!.title}`);
  expect([dossier(C180).querySelector('[data-attention]'), text(dossier(C180).querySelector('[data-attention-none]'))], 'no rows when nothing has entries')
    .toEqual([null, 'Nothing holds this up.']);
});

test('parts in Verify or Ready to merge get their own row after Needs you, which with the chip counts only Needs you', async () => {
  await mountPage(withItem('I_sample10', { status: 'Verify' }, withItem('I_sample13', { status: 'Ready to merge', blockers: [] })));
  const rows = [...dossier().querySelectorAll<HTMLElement>('[data-attention-row]')].map((r) => text(r.firstElementChild));
  expect(rows.slice(0, 2)).toEqual(['Needs you 1', 'To verify or merge 2']);
  expect(chips()).toContain('1 need you');
  expect(text(next()), "what's next names the part in Needs you first").toBe('Needs you#202 Sign-in screen');
  await receive(withItem('I_sample12', { status: 'Verify' }, withItem('I_sample10', { status: 'Verify' }, withItem('I_sample13', { status: 'Ready to merge', blockers: [] }))));
  expect([chips(), text(next())], 'with none in Needs you, no need-you chip and no Needs you wording').toEqual([['2 decisions', '2 fog'], 'To verify#202 Sign-in screen']);
  await receive(withItem('I_sample12', { status: 'Done' }, withItem('I_sample10', { status: 'Done' }, withItem('I_sample13', { status: 'Ready to merge', blockers: [] }))));
  expect(text(next()), 'a part ready to merge is named to merge').toBe('To merge#140 Owner accounts');
  await receive(withItem('I_sample10', { status: 'Verify' }, withItem('I_sample13', { status: 'Ready to merge', blockers: [] })));
  const verify = dossier().querySelector('[data-attention-row="verify"]')!;
  expect([verify.firstElementChild!.className.split(' '), dossier().querySelector('[data-attention]')!.className.split(' ')], 'its long label never wraps: the labels\' column grows past 7.5rem to fit it')
    .toEqual([expect.arrayContaining(['whitespace-nowrap']), expect.arrayContaining(['grid-cols-[minmax(7.5rem,max-content)_minmax(0,1fr)]'])]);
  expect([...verify.lastElementChild!.children].map(text)).toEqual(['#140 Owner accountsReady to merge', '#201 Relay: broker only or full TURN?Verify']);
  await press(button(verify, '#140 Owner accounts'));
  expect(dialogTitle()).toBe('#140 Owner accounts');
});

test('blocked slices name the part they belong to and what they wait on', async () => {
  const s13 = sample.items.find((i) => i.id === 'I_sample13')!;
  await mountPage(withItem('I_sample13', { slices: s13.slices.map((x, n) => (n === 0 ? { ...x, progress: 'blocked' as const } : x)) }));
  const blocked = dossier().querySelector('[data-attention-row="blocked"]')!;
  expect([text(blocked.firstElementChild), [...blocked.lastElementChild!.children].map(text)])
    .toEqual(['Blocked slices 1', [`#${s13.slices[0]!.number} ${s13.slices[0]!.title}slice of #140 · waits on a re-slice`]]);
  await press(button(blocked, '#140'));
  expect(dialogTitle()).toBe('#140 Owner accounts');
});

test('a part with nothing to wait on is ready to start, with its Start', async () => {
  holdPosts(unblocked());
  await mountPage(unblocked());
  const ready = dossier().querySelector('[data-attention-row="ready"]')!;
  expect([text(ready.firstElementChild), text(ready.querySelector('dd > div > span'))]).toEqual(['Ready to start 1', '#140 Owner accounts']);
  expect(dossier().querySelector('[data-attention-row="waiting"]'), 'nothing waits').toBeNull();
  await pressMenu(startIn(ready)!);
  expect(dialogTitle(), 'Start opens its menu, not the dialog').toBe('');
  await press(entries()[1]!);
  expect(posted()).toEqual([['/api/start-build', { session: 's1', itemId: 'I_sample13', model: { instanceId: 'codex', model: 'gpt-5.5' } }]]);
});

test('the Ready to start row and the header agree on what can start: a Queued decision can, a part with a live thread cannot', async () => {
  const data = withItem('I_sample12', { status: 'Shaping' }, withDecision());
  await mountPage(data);
  const ready = () => dossier().querySelector('[data-attention-row="ready"]');
  expect([text(ready()!.firstElementChild), text(startIn(next()))]).toEqual(['Ready to start 1', 'Start ▾']);
  await receive(withItem('I_d204', { threads: [thread('t1', 'running')] }, data));
  expect([ready(), startIn(next())], 'a live thread').toEqual([null, null]);
});

test('a dossier opens on its Work map, and the browser remembers a switch to the parts list for that dossier alone', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  for (const id of [C200, C180]) localStorage.removeItem(VIEW_KEY + id);
  await mountPage();
  expect([button(dossier(), 'Work map').getAttribute('aria-pressed'), dossier().querySelector('[data-work-map]') !== null]).toEqual(['true', true]);
  await press(button(dossier(), 'Parts list'));
  expect([dossier().querySelector('[data-work-map]'), dossier().querySelector('[data-parts-list]') !== null, localStorage.getItem(VIEW_KEY + C200)]).toEqual([null, true, 'list']);
  vi.resetModules();
  await mountPage();
  expect(button(dossier(), 'Parts list').getAttribute('aria-pressed'), 'it stays on the parts list').toBe('true');
  expect(button(dossier(C180), 'Work map').getAttribute('aria-pressed'), 'the other dossier stays on its Work map').toBe('true');
});

test('the parts list holds the open parts in dependency order, two columns where there is room, the done ones behind Show N done', async () => {
  await mountPage();
  expect(listed()).toEqual(['I_sample12', 'I_sample10', 'I_sample13']);
  expect(dossier().querySelector('[data-parts-list]')!.className.split(' ')).toContain('@4xl:grid-cols-2');
  const fold = button(dossier(), 'Show 1 done');
  await press(fold);
  expect([text(fold), fold.getAttribute('aria-expanded'), listed().length]).toEqual(['Hide 1 done', 'true', 4]);
  expect(listed(C180), 'all done').toEqual([]);
  await press(button(dossier(C180), 'Show 2 done'));
  expect(listed(C180).length).toBe(2);
});

test('the open body has no Check phase, progress rows or stage header; the Work map keeps the end-to-end check', async () => {
  await mountPage();
  expect(text(dossier())).not.toContain('Run end-to-end');
  expect(text(dossier())).not.toContain('Progress · ');
  expect(dossier().querySelectorAll('[data-item]').length, "only the header's").toBe(1);
});

test('each part shows what it asks next, then its stage track, status, figures and thread, and its slice bar', async () => {
  await mountPage(withItem('I_sample13', { azure: { type: 'Feature', state: 'Active', assignee: 'Ana' },
    linkedPrs: [{ ...sample.items.flatMap((i) => i.linkedPrs)[0]!, number: 145, state: 'open', isDraft: false }] }));
  const lines = (id: string) => [...step(id).children].map(text);
  expect(lines('I_sample10')).toEqual(['#201 Relay: broker only or full TURN?', 'Open thread', 'Shaping28m · 1.87M · $2.71T3 · Grill: relay broker only or full TURN· running']);
  expect(lines('I_sample12')).toEqual(['#202 Sign-in screen', 'on your desk', 'Needs you41m · 2.95M · $4.35T3 · Prototype: sign-in screen· needs you']);
  expect(lines('I_sample13').slice(0, 3)).toEqual(['#140 Owner accounts', '1/3Start after #202 ▾', 'ReadyFeature · Active · AnaPR #145T3 · Shape: owner accounts· done']);
  expect(step('I_sample13').querySelector('[data-part-meta] ol')!.getAttribute('title'), "the stage track, dashed while it waits").toBe('Ready, waiting');
  expect(step('I_sample10').querySelector('[data-part-meta] ol')!.getAttribute('title')).toBe('Shaping');
  expect(step('I_sample13').children[3]!.className.split(' '), 'its slice bar under the row').toContain('col-span-2');
  await press(button(step('I_sample10'), '#201 Relay: broker only or full TURN?'));
  expect(dialogTitle(), 'a part opens its item').toBe('#201 Relay: broker only or full TURN?');
});

test('a part waiting on another, with no Start of its own, says what it waits on', async () => {
  await mountPage(withItem('I_sample10', { blockers: [{ number: 140, repo: 'maddec01/lar-server', state: 'open' }] }));
  expect(text(step('I_sample10').children[1])).toBe('waits on #140');
  expect([...step('I_sample10').children[1]!.querySelectorAll('button, svg')], 'plain text: no chip, no status icon').toEqual([]);
  const side = dossier().querySelector('[data-attention-row="waiting"] dd > div > span:last-child')!;
  expect([text(side), side.children.length], 'the Waiting row says it the same way').toEqual(['waits on #202', 0]);
});

test('a part with no thread yet says when its thread starts', async () => {
  await mountPage(withItem('I_sample13', { threads: [] }));
  expect(text(step('I_sample13').querySelector('[data-part-meta]')!.lastElementChild)).toBe('Thread starts when #202 is done');
});

test('a part held by a Dependency says its thread starts once you mark the Dependency met', async () => {
  const dependency: DependencyHold = { dependencyId: 'dep-1', revision: 1, owner: 'server team', need: 'An export endpoint', ticket: null, named: [], evidence: '',
    met: null, needsReview: false, observation: null };
  await mountPage(withItem('I_sample13', { threads: [], blockers: [{ number: 202, repo: 'maddec01/lar-server', state: 'open' },
    { number: 0, repo: 'server team', state: 'open', title: dependency.need, dependency }] }));
  expect(text(step('I_sample13').querySelector('[data-part-meta]')!.lastElementChild))
    .toBe('Thread starts when #202 is done and you mark the Dependency on server team met');
});

test('a Ready part with completed prerequisites offers Start without blocking wording', async () => {
  await mountPage(unblocked());
  const part = step('I_sample13');
  expect(text(startIn(part))).toBe('Start ▾');
  expect(text(part)).not.toContain('waits on');
});

test('a blocked build shows only Start after, a Start, in place of Start build', async () => {
  await mountPage();
  expect(startIn(step('I_sample13'))).toBeNull();
  const after = step('I_sample13').querySelector<HTMLElement>('[data-start-after]')!;
  expect([text(after), after.dataset.kind]).toEqual(['Start after #202 ▾', 'start']);
  expect(text(next()), 'the header offers no start while a part waits on you').toBe('Needs you#202 Sign-in screen');
});

test('once its blockers complete, Start build sends the build, and the header offers it too', async () => {
  holdPosts(unblocked());
  await mountPage(withItem('I_sample12', { status: 'Shaping' }, unblocked()));
  expect(text(startIn(next()))).toBe('Start ▾');
  await pressMenu(startIn(step('I_sample13'))!);
  expect(dialogTitle(), 'the menu opens without the dialog').toBe('');
  await press(entries()[1]!);
  expect(posted()).toEqual([['/api/start-build', { session: 's1', itemId: 'I_sample13', model: { instanceId: 'codex', model: 'gpt-5.5' } }]]);
  await answer({ thread: null, error: 'T3 is down.' }, 502);
  expect(text(dossier().querySelector('p.start [role="alert"]')), 'its error shows under its row').toBe('T3 is down.');
});

/** #140, Ready, also carrying Verify. */
test("Start on a Queued decision is today's Start", async () => {
  holdPosts(withDecision());
  await mountPage(withDecision());
  expect(text(step('I_d204'))).toMatch(/^#204 Pick the relay hostStart ▾/);
  await pressMenu(startIn(step('I_d204'))!);
  await press(entries()[0]!);
  expect(posted()).toEqual([['/api/start', { session: 's1', itemId: 'I_d204' }]]);
});

test('a Queued decision shows only Start after while a blocker is open, naming the last open one', async () => {
  const data = withDecision([{ number: 201, repo: 'maddec01/lar-server', state: 'open' }, { number: 203, repo: 'maddec01/lar-server', state: 'closed' },
    { number: 140, repo: 'maddec01/lar-server', state: 'open' }]);
  holdPosts(data);
  await mountPage(data);
  expect(startIn(step('I_d204'))).toBeNull();
  const after = step('I_d204').querySelector<HTMLButtonElement>('[data-start-after]')!;
  expect([text(after), after.title]).toEqual(['Start after #140 ▾', 'Starts by itself once #201, #140 complete']);
  await pressMenu(after);
  await press(entries()[0]!);
  expect(posted(), 'T3 default arms it with no model').toEqual([['/api/arm', { session: 's1', itemId: 'I_d204' }]]);
  await answer({ error: null, board: { ...data, armed: { I_d204: {} } } });
  expect(text(step('I_d204').querySelector('[data-start-after]'))).toBe('Starts after #140 ✓');
});

test('in the map, a part waiting on something that is neither Ready nor Queued starts by itself after it', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  await mountPage(withItem('I_sample10', { blockers: [{ number: 203, repo: 'maddec01/lar-server', state: 'open' }] }));
  await press(button(dossier(), 'Work map'));
  expect(text(dossier().querySelector('[data-map-part="I_sample10"]'))).toContain('starts by itself after #203');
});

test("in the map, a part waiting on another repository's issue names it without its owner", async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  await mountPage(withItem('I_sample10', { blockers: [{ number: 12, repo: 'maddec01/lar-apple', state: 'open' }] }));
  await press(button(dossier(), 'Work map'));
  expect(text(dossier().querySelector('[data-map-part="I_sample10"]'))).toContain('starts by itself after lar-apple#12');
});

test('Open thread takes Start\'s place while a part has a live thread', async () => {
  const data = withDecision();
  await mountPage(withItem('I_d204', { threads: [thread('t1', 'running')] }, data));
  expect(startIn(step('I_d204'))).toBeNull();
  expect(step('I_d204').querySelector('[data-open-thread]')!.getAttribute('href')).toBe('t3code://threads/sample-environment/t1');
});

test('a map with no End-to-end check section says none is written', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const { check: _, ...map } = c200.map!;
  await mountPage(withItem(C200, { map }));
  await press(button(dossier(), 'Work map'));
  expect(text(dossier().querySelector('[data-work-map]'))).toContain('No end-to-end check written yet');
});

test('neither the parts list nor the Work map lanes draw a coloured repository dot', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  await mountPage();
  await press(button(dossier(), 'Show 1 done'));
  expect([listed().length, dossier().querySelector('[class*="repo-tone"]')]).toEqual([4, null]);
  await press(button(dossier(), 'Work map'));
  expect([dossier().querySelectorAll('[data-work-map] .sticky').length, dossier().querySelector('[class*="repo-tone"]')]).toEqual([2, null]);
});

test('a Map lane named owner/name shows it once', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  await mountPage({ ...sample, repos: [...sample.repos, { repo: 'fabrikam/lar-server', role: 'fork', labels: [] }] });
  await press(button(dossier(), 'Work map'));
  const lanes = [...dossier().querySelectorAll('[data-work-map] .sticky')];
  expect(lanes.map(text)).toEqual(['Decisionsgrill, prototype, research', 'maddec01/lar-server']);
});

test('the Map view draws a lane per repository and Decisions, its parts by wave, and arrows for what waits on what', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  await mountPage();
  const toggle = button(dossier(), 'Work map');
  await press(toggle);
  expect([toggle.getAttribute('aria-pressed'), button(dossier(), 'Parts list').getAttribute('aria-pressed')]).toEqual(['true', 'false']);
  const map = dossier().querySelector('[data-work-map]')!;
  expect(dossier().querySelector('[data-parts-list]'), "the map takes the parts list's place").toBeNull();
  expect([...map.querySelectorAll('.sticky')].map(text)).toEqual(['Decisionsgrill, prototype, research', 'lar-servermaddec01/lar-server']);
  const subtitle = map.querySelectorAll('.sticky')[1]!.lastElementChild!;
  expect([subtitle.className.split(' ').includes('truncate'), subtitle.getAttribute('title')], 'owner/name stays on one line').toEqual([true, 'maddec01/lar-server']);
  expect([...map.querySelectorAll('.h-7\\.5')].map(text)).toEqual(['Wave 1· 2 in parallel', 'Wave 2· 2 in parallel', 'Check']);
  expect([...map.querySelectorAll('[data-map-part]')].map((n) => n.getAttribute('data-map-part'))).toEqual(['I_sample18', 'I_sample12', 'I_sample10', 'I_sample13']);
  expect([...map.querySelectorAll('path[data-edge]')].map((p) => p.getAttribute('data-edge'))).toEqual([
    'I_sample18 I_sample10', 'I_sample12 I_sample13', 'I_sample13 e2e',
  ]);
  expect(text(map.querySelector('[data-map-check]'))).toBe('end-to-end checkSign in on the website, then stream from a phone off Wi-Fiwaiting · 3 stepsagents run it once #140 land');
  const node = (id: string) => map.querySelector(`[data-map-part="${id}"]`)!;
  expect(startIn(node('I_sample13')), 'a blocked part offers Start after alone').toBeNull();
  expect(text(node('I_sample13').querySelector('[data-start-after]'))).toBe('Start after #202 ▾');
  expect(text(node('I_sample12').querySelector('[data-open-thread]'))).toBe('Answer in T3');
  await press(node('I_sample10').querySelector('button')!);
  expect(dialogTitle()).toBe('#201 Relay: broker only or full TURN?');
});

test('an item with sub-issues on the board is coupled work, its parts from its children', async () => {
  const parent = rawIssue('I_parent', 100, 'In progress', ['build'], {
    subIssuesSummary: { total: 3, completed: 0 },
    subIssues: { nodes: [sliceRef(101, 'OPEN'), sliceRef(102, 'OPEN'), sliceRef(103, 'OPEN')] },
  });
  const child = rawIssue('I_102', 102, 'In progress', ['build'], {
    parent: { number: 100, title: 'Issue 100', url: 'https://github.com/maddec01/lar-factory/issues/100', state: 'OPEN', repository: { nameWithOwner: 'maddec01/lar-factory' } },
  });
  await mountPage({ ...sample, error: null, items: recorded(normalizeItems([parent, child], { builds: new Set(['maddec01/lar-factory#102', 'maddec01/lar-factory#103']) })) });
  expect([text(line(1, 'I_100').firstElementChild!.firstElementChild!.firstElementChild), text(line(2, 'I_100'))]).toEqual(['Coupled work', '0/2 partsMoving#102 Issue 102lar-factory']);
  expect(listed('I_100'), 'its build sub-issue is a part; its slice is not').toEqual(['I_102']);
  expect($('[data-in-flight] [data-item="I_102"]'), 'out of the rest of the line').toBeNull();
});

test('the dossiers take the main area\'s scope', async () => {
  await mountPage();
  const { useScopeStore } = await import('../board/scope-store.ts');
  await settle(() => useScopeStore.getState().setScope('maddec01/lar-apple'));
  expect($$('[data-dossier]').map((d) => d.getAttribute('data-dossier')), '#180 through its Apple build').toEqual([C180]);
});

test('the parts list keeps cross-repository dependency order even when builds return to a repository', async () => {
  const first = { ...sample.items.find((i) => i.id === 'I_sample24')!, state: 'open' as const, status: 'Ready' as const, blockers: [] };
  const second = { ...sample.items.find((i) => i.id === 'I_sample25')!, state: 'open' as const, status: 'Ready' as const };
  const last: Item = { ...first, id: 'I_last', number: 999, title: 'Finish in the server', blockers: [{ repo: second.repo!, number: second.number!, state: 'open' }] };
  await mountPage({ ...sample, items: [...sample.items.filter((i) => ![first.id, second.id].includes(i.id)), last, second, first] });
  expect([...dossier(C180).querySelectorAll('[data-parts-list] [data-part]')].map((p) => p.getAttribute('data-part'))).toEqual([first.id, second.id, last.id]);
});

test('the parts list keeps a build before a research decision blocked by that build', async () => {
  const build = { ...sample.items.find((i) => i.id === 'I_sample13')!, blockers: [] };
  const research = { ...decision([{ repo: build.repo!, number: build.number!, state: 'open' }]), labels: ['decision-research'] };
  await mountPage({ ...sample, items: [c200, research, build] });
  expect([...dossier().querySelectorAll('[data-parts-list] [data-part]')].map((p) => p.getAttribute('data-part'))).toEqual([build.id, research.id]);
});

test("a concept map's Dependencies show as a Dependencies row, after what waits and before the fog", async () => {
  const dependencies = ['A resume endpoint, from team/relay, blocks #140'];
  await mountPage(withItem(C200, { map: { ...c200.map!, dependencies } }));
  const rows = [...dossier().querySelectorAll<HTMLElement>('[data-attention-row]')].map((r) => r.dataset.attentionRow);
  expect(rows).toEqual(['you', 'decisions', 'waiting', 'dependencies', 'fog']);
  const row = dossier().querySelector('[data-attention-row="dependencies"]')!;
  expect([text(row.firstElementChild), [...row.querySelector('dd')!.children].map(text)]).toEqual(['Dependencies 1', dependencies]);
  await press(button(row, '#140'));
  expect(dialogTitle(), "a Dependency's #n opens its item").toBe(`#140 ${sample.items.find((i) => i.number === 140)!.title}`);
});

test('a concept with no map has no fog row', async () => {
  const concept = rawIssue('I_concept', 700, 'Shaping', ['concept'], { body: 'A concept written as ordinary prose.' });
  await mountPage({ ...sample, items: normalizeItems([concept]) });
  expect([dossier('I_700').querySelector('[data-attention]'), dossier('I_700').querySelector('[data-about]')]).toEqual([null, null]);
});
