import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vite-plus/test';
import { effectiveVocabulary, type PublicationBoardState, type PublicationPlan } from '@lar-factory/shared';
import { $, $$, fetchMock, sample, settle, text } from '../../test/support.ts';
let useBoardStore: typeof import('../board/board-store.ts')['useBoardStore'];
let usePublicationStore: typeof import('./publication-store.ts')['usePublicationStore'];
let PublicationDialog: typeof import('./publication-dialog.tsx')['PublicationDialog'];
let PublishButton: typeof import('./publication-dialog.tsx')['PublishButton'];
async function load() {
  ({ useBoardStore } = await import('../board/board-store.ts'));
  ({ usePublicationStore } = await import('./publication-store.ts'));
  ({ PublicationDialog, PublishButton } = await import('./publication-dialog.tsx'));
}

const plan: PublicationPlan = {
  planId: 'plan-1', workId: 'work', revision: 1, digest: 'exact-content', sources: [], replaces: null, supersededBy: null, proposedAt: '', approval: null,
  tickets: ['team/app', 'team/api'].map((repository, index) => ({ workId: `work-${index}`, title: `Search ${index}`, body: `Complete exact content ${index}`, destination: { provider: 'github', repository }, vocabulary: { build: { type: 'Task', labels: ['Search'] } }, typeResolution: { candidates: ['Task'], selected: 'Task' } })),
  operations: [{ operationId: 'create:0', kind: 'create', ticketWorkId: 'work-0', dependsOn: [] }, { operationId: 'create:1', kind: 'create', ticketWorkId: 'work-1', dependsOn: ['create:0'] }], results: [],
};
const state: PublicationBoardState = { readiness: { eligible: true, reasons: [], sources: [] }, sources: [], settings: [], firstUse: false,
  pending: { plan, current: false, reasons: ['The exact publication content needs approval.'], next: null, successful: [], failed: [], uncertain: [] } };
let root: Root;
afterEach(async () => { await settle(() => root?.unmount()); usePublicationStore.setState({ workId: null, state: null, busy: false, error: null }); });
async function mount() {
  await load();
  document.body.innerHTML = '<div id="publication"></div>';
  root = createRoot(document.getElementById('publication')!);
  useBoardStore.setState({ data: { ...sample, capture: { ...sample.capture!, enabled: true, session: 'session' } } });
  await settle(() => root.render(createElement(PublicationDialog)));
}
const button = (label: string) => $$<HTMLButtonElement>('button').find((b) => text(b) === label)!;

test('a picked Azure preview separates the preserved HTML from the exact addition and offers safer delivery', async () => {
  await mount();
  const operation: PublicationPlan['operations'][number] = { operationId: 'append', ticketWorkId: 'work-0', kind: 'append', dependsOn: [],
    expectedText: '', content: '<h2>Refined description</h2><pre>Find saved searches.</pre>', location: { kind: 'body', start: 73, end: 73, field: 'System.Description' },
    expected: { body: '<table><tr><td colspan="2" style="color:red">Original</td></tr></table>', format: 'html', revision: 4, assigned: false, linkedPullRequest: false } };
  const preview = { ...state, pending: { ...state.pending!, plan: { ...plan, tickets: [{ ...plan.tickets[0]!, destination: { provider: 'azure', repository: 'org/project/repo', ticket: 'org/project/repo#12' } }], operations: [operation], results: [{ operation, status: 'pending', attempt: null }] } } };
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(preview)));
  await settle(() => usePublicationStore.getState().open('work'));
  expect(text($('[data-original-description]'))).toBe(operation.expected!.body);
  expect(text($('[data-refined-addition]'))).toBe(operation.content);
  expect(text(document.body)).toContain('HTML stays in its original format');
  expect($('table')).toBeNull();
  expect(button('Preview new comment')).toBeDefined();
  expect(button('Preview markdown handover')).toBeDefined();
});

test('the full multi-ticket preview shows destinations, exact content, terms and ordered operations; cancelling writes nothing', async () => {
  await mount();
  fetchMock.mockResolvedValue(new Response(JSON.stringify(state)));
  await settle(() => usePublicationStore.getState().open('work'));
  expect(text($('[data-publication-dialog]'))).toContain('Complete exact content 0');
  expect(text($('[data-publication-dialog]'))).toContain('Complete exact content 1');
  expect(text($('[data-publication-dialog]'))).toContain('team/api');
  expect(text($('[data-publication-dialog]'))).toContain('Task');
  expect($$('[data-publication-operation]').map(text)).toEqual(expect.arrayContaining([expect.stringContaining('create')]));
  await settle(() => button('Cancel').click());
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect($('[data-publication-dialog]')).toBeNull();
});

test('approval sends the stored plan identity once, and shows successful ticket links', async () => {
  await mount();
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(state)));
  await settle(() => usePublicationStore.getState().open('work'));
  let finish!: (response: Response) => void;
  fetchMock.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  await settle(() => { button('Approve publication').click(); button('Approve publication').click(); });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(JSON.parse((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body as string)).toEqual({ workId: 'work', session: 'session', planId: 'plan-1', revision: 1, digest: 'exact-content' });
  const result = { ...state, pending: { ...state.pending!, plan: { ...plan, approval: { approvedBy: 'board user', approvedAt: '', digest: plan.digest }, results: [{ operation: plan.operations[0], status: 'successful', attempt: { url: 'https://tickets.example/12', ticket: 'team/app#12' } }] }, successful: ['create:0'] } };
  await settle(() => finish(new Response(JSON.stringify(result))));
  expect($<HTMLAnchorElement>('a[href="https://tickets.example/12"]')).not.toBeNull();
});

test('ineligible work explains why and sample mode disables publication without removing private actions', async () => {
  await load();
  document.body.innerHTML = '<div id="publication"></div>';
  root = createRoot(document.getElementById('publication')!);
  const item = { ...sample.items[0]!, publication: { eligible: false, reasons: ['The concept still has Fog.'] } };
  await settle(() => root.render(createElement(PublishButton, { item, data: sample })));
  expect(text(document.body)).toContain('The concept still has Fog.');
  expect(button('Publish').disabled).toBe(true);
  await settle(() => root.render(createElement(PublishButton, { item: { ...item, publication: { eligible: true, reasons: [] } }, data: { ...sample, capture: { ...sample.capture!, enabled: false } } })));
  expect(text(document.body)).toContain('sample mode');
});

test('a changed plan blocks approval, and failed and uncertain operations stay separate', async () => {
  await mount();
  const changed = { ...state, pending: { ...state.pending!, reasons: ['The publication source changed; prepare and approve a new plan.'],
    plan: { ...plan, results: [{ operation: plan.operations[0], status: 'failed', attempt: { evidence: 'Permission refused.' } }, { operation: plan.operations[1], status: 'uncertain', attempt: { evidence: 'Connection lost.' } }] },
    failed: ['create:0'], uncertain: ['create:1'] } };
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(changed)));
  await settle(() => usePublicationStore.getState().open('work'));
  expect(button('Approve publication').disabled).toBe(true);
  expect(text($('[data-publication-result="failed"]'))).toContain('Permission refused.');
  expect(text($('[data-publication-result="uncertain"]'))).toContain('Connection lost.');
  expect(button('Inspect uncertain outcomes')).toBeDefined();
  expect($$('button').some((b) => text(b) === 'Preview fallback')).toBe(false);
});

test('a live board source revision change disables approval until the journal is refreshed', async () => {
  await mount();
  const source = { workId: sample.items[0]!.id, revision: 3, title: 'Search', kind: 'build', repository: 'team/app', body: '' };
  useBoardStore.setState({ data: { ...useBoardStore.getState().data, items: [{ ...sample.items[0]!, revision: 4 }] } });
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ...state, sources: [source] })));
  await settle(() => usePublicationStore.getState().open('work'));
  expect(button('Approve publication').disabled).toBe(true);
  expect(text(document.body)).toContain('Refresh the journal before approving');
});

test('first publication reuses Vocabulary then asks one local permission question per step with refused reasons', async () => {
  await mount();
  const { effectiveVocabulary, REPOSITORY_OPERATIONS } = await import('@lar-factory/shared');
  const setup: PublicationBoardState['settings'][number]['setup'] = {
    repo: 'team/app', role: '', itemSource: { kind: 'issues' }, labels: [], domainDocs: { kind: 'private' }, skills: [], ...effectiveVocabulary(), consent: [], paused: [], shared: {},
    sources: { role: 'default', itemSource: 'default', labels: 'default', domainDocs: 'default', skills: 'default', vocabulary: 'default' },
    access: Object.fromEntries(REPOSITORY_OPERATIONS.map((op) => [op, op === 'publish-ticket' ? 'refused' : 'unverified'])) as PublicationBoardState['settings'][number]['setup']['access'],
  };
  const first: PublicationBoardState = { ...state, firstUse: true, pending: null, sources: [{ workId: 'work', revision: 1, title: 'Search', repository: 'team/app', kind: 'build', body: 'Private brief.' }],
    settings: [{ setup, discovery: { provider: 'github', types: { state: 'available', choices: ['Task'] }, labels: { state: 'refused', reason: 'Labels permission denied.' } } }] };
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(first)));
  await settle(() => usePublicationStore.getState().open('work'));
  expect(text(document.body)).toContain('What we found');
  expect(text(document.body)).toContain('Refused: Labels permission denied.');
  await settle(() => button('Next').click());
  for (let i = 0; i < 12; i++) {
    expect($$('legend')).toHaveLength(1);
    await settle(() => button('Save and next').click());
  }
  expect(text($('legend'))).toBe('May publication create tickets?');
  expect(text(document.body)).toContain('Refused: the saved credential check refused this operation.');
  expect($<HTMLButtonElement>('[data-choice="yes"] [role="radio"]')!.disabled).toBe(true);
  fetchMock.mockImplementation(async () => new Response(JSON.stringify({ setup, error: null })));
  for (let i = 0; i < 6; i++) {
    expect($$('legend')).toHaveLength(1);
    await settle(() => button('Save and next').click());
  }
  expect($('[data-publication-documents]')).not.toBeNull();
  expect(button('Preview publication').disabled).toBe(true);
  expect(fetchMock.mock.calls.every(([url]) => !String(url).endsWith('/approve'))).toBe(true);
});

test('a conflicting effective type blocks preview until the user explicitly chooses none', async () => {
  await mount();
  const { effectiveVocabulary } = await import('@lar-factory/shared');
  const first: PublicationBoardState = { ...state, pending: null, sources: [{ workId: 'work', revision: 1, title: 'Search', repository: 'team/app', kind: 'bug', body: 'Private brief.' }],
    settings: [{ setup: { repo: 'team/app', role: '', itemSource: { kind: 'issues' }, labels: [], domainDocs: { kind: 'private' }, skills: [], ...effectiveVocabulary({ build: { type: 'Task', labels: [] }, bug: { type: 'Bug', labels: [] } }), consent: [], paused: [], shared: {}, sources: {} as PublicationBoardState['settings'][number]['setup']['sources'], access: {} as PublicationBoardState['settings'][number]['setup']['access'] },
      discovery: { provider: 'github', types: { state: 'available', choices: ['Task', 'Bug'] }, labels: { state: 'available', choices: [] } } }] };
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(first)));
  await settle(() => usePublicationStore.getState().open('work'));
  await settle(() => usePublicationStore.getState().editDocument('work', { outcome: 'Find searches.', change: 'Add a filter.', checks: ['A named search is found.'] }));
  expect(button('Preview publication').disabled).toBe(true);
  await settle(() => $<HTMLButtonElement>('[data-choice=""] [role="radio"]')!.click());
  expect(button('Preview publication').disabled).toBe(false);
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(state)));
  await settle(() => button('Preview publication').click());
  const input = JSON.parse((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body as string) as { typeSelections: object };
  expect(input.typeSelections).toEqual({ work: null });
  expect($('[data-publication-preview]')).not.toBeNull();
});

test('refreshing a changed concept adds new ticket drafts without dropping the user\'s existing projection', async () => {
  await mount();
  const source = { workId: 'work', revision: 1, title: 'Search', repository: 'team/app', kind: 'build', body: 'Private brief.' };
  const initial: PublicationBoardState = { ...state, sources: [source] };
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(initial)));
  await settle(() => usePublicationStore.getState().open('work'));
  await settle(() => usePublicationStore.getState().editDocument('work', { outcome: 'Keep my team projection.' }));
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ...initial, sources: [source, { ...source, workId: 'new-build', title: 'Search API' }] })));
  await settle(() => usePublicationStore.getState().request('inspect'));
  expect(usePublicationStore.getState().documents.map((doc) => [doc.workId, doc.title, doc.outcome])).toEqual([
    ['work', 'Search', 'Keep my team projection.'], ['new-build', 'Search API', ''],
  ]);
});

test('handover can be copied or downloaded and an inspected posted URL is attached to the same work', async () => {
  await mount();
  const handover = '# Find searches\n\n## Outcome\n\nFind saved searches.\n\n## Decisions and reasons\n\nUse prefixes because results stay predictable.\n';
  const handoverState = { ...state, handover, pending: { ...state.pending!, plan: { ...plan, operations: [], results: [] } } };
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(handoverState)));
  await settle(() => usePublicationStore.getState().open('work'));
  const clipboard = vi.fn(async () => {});
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: clipboard } });
  await settle(() => button('Copy markdown handover').click());
  expect(clipboard).toHaveBeenCalledWith(handover);
  const download = $<HTMLAnchorElement>('a[download]')!;
  expect(decodeURIComponent(download.href.split(',').slice(1).join(','))).toBe(handover);
  expect(button('Approve publication')).toBeUndefined();
  const url = 'https://github.com/team/app/issues/12';
  await changeInput($<HTMLInputElement>('input[type="url"]')!, url);
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ...handoverState, resolvedUrl: { workId: 'work-0', revision: 7, ticket: 'team/app#12', url, body: 'Posted exact text.', format: 'markdown' } })));
  await settle(() => button('Inspect posted URL').click());
  expect(text(document.body)).toContain('Resolved destination: team/app#12');
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ...handoverState, attachments: [{ workId: 'work-0', planId: 'plan-1', ticket: 'team/app#12', url, recordedAt: '' }] })));
  await settle(() => button('Attach inspected URL to this work').click());
  const [path, input] = fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit];
  expect(path).toBe('/api/publication/attach-url');
  expect(JSON.parse(input.body as string)).toMatchObject({ workId: 'work', targetWorkId: 'work-0', revision: 7, planId: 'plan-1', url });
  expect(text(document.body)).toContain('Attached to the same local work');
});

async function changeInput(input: HTMLInputElement, value: string) {
  await settle(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

test('a teammate conflict shows both versions and selects an explicit range for a new unapproved preview', async () => {
  await mount();
  const source = { workId: 'work-0', revision: 2, title: 'Search', repository: 'team/app', kind: 'build', body: 'Private brief.', ticket: 'team/app#12' };
  const { effectiveVocabulary } = await import('@lar-factory/shared');
  const setup: PublicationBoardState['settings'][number]['setup'] = { repo: 'team/app', role: '', itemSource: { kind: 'issues' }, labels: [], domainDocs: { kind: 'private' }, skills: [], ...effectiveVocabulary(),
    access: {} as PublicationBoardState['settings'][number]['setup']['access'], consent: [], paused: [], shared: {},
    sources: { role: 'default', itemSource: 'default', labels: 'default', domainDocs: 'default', skills: 'default', vocabulary: 'default' } };
  const conflict = { workId: 'work-0', stored: 'Old refinement', current: 'Unrelated\nTeammate edit\nKeep this', proposed: 'New agreed outcome', location: { kind: 'body', start: 10, end: 23 }, reason: 'A teammate changed the publication.' };
  const conflicted = { ...state, sources: [source], settings: [{ setup, discovery: { provider: 'github', types: { state: 'available', choices: [] }, labels: { state: 'available', choices: [] } } }],
    readiness: { eligible: true, reasons: [], sources: [{ workId: 'work-0', revision: 2 }] }, pending: { ...state.pending!, conflicts: [conflict], reasons: ['A teammate changed the publication.'] } };
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(conflicted)));
  await settle(() => usePublicationStore.getState().open('work'));
  expect(text($('[data-publication-conflict]'))).toContain('Old refinement');
  expect(text($('[data-publication-conflict]'))).toContain('Teammate edit');
  expect(text($('[data-publication-conflict]'))).toContain('New agreed outcome');
  expect(button('Approve publication').disabled).toBe(true);
  const fields = $$<HTMLInputElement>('input[type="number"]');
  await changeInput(fields[0]!, '10'); await changeInput(fields[1]!, '23');
  expect(text($('[data-resolution-selection]'))).toBe('Teammate edit');
  await settle(() => button('Use selected range').click());
  expect(usePublicationStore.getState().mode).toBe('edit');
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await settle(() => usePublicationStore.getState().editDocument('work-0', { outcome: 'Find searches.', change: 'Use prefix matching.', checks: ['A named search is found.'] }));
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ...state, pending: { ...state.pending!, plan: { ...plan, planId: 'resolved-plan' } } })));
  await settle(() => button('Preview publication').click());
  const [path, input] = fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit];
  expect(path).toBe('/api/publication/prepare');
  expect(JSON.parse(input.body as string)).toMatchObject({ replaces: 'plan-1', resolutions: { 'work-0': { observedText: conflict.current, expectedText: 'Teammate edit', location: { kind: 'body', start: 10, end: 23 } } } });
  expect(usePublicationStore.getState().state!.pending!.plan.approval).toBeNull();
});

test('uncertain recovery exposes inspected candidates and an existing URL, never a direct retry', async () => {
  await mount();
  const uncertain = { ...state, pending: { ...state.pending!, plan: { ...plan, approval: { approvedBy: 'board user', approvedAt: '', digest: plan.digest },
    results: [{ operation: plan.operations[0], status: 'uncertain', attempt: { evidence: 'Lost response.' } }] }, uncertain: ['create:0'] },
    candidates: [{ operationId: 'create:0', tickets: [{ ticket: 'team/app#19', url: 'https://github.com/team/app/issues/19' }], evidence: 'Inspected one exact match.' }] };
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(uncertain)));
  await settle(() => usePublicationStore.getState().open('work'));
  expect($('a[href="https://github.com/team/app/issues/19"]')).not.toBeNull();
  expect(button('Preview retry of remaining writes')).toBeUndefined();
  expect(button('Record that this write did not complete').disabled).toBe(true);
  await changeInput($<HTMLInputElement>('input[type="url"]')!, 'https://github.com/team/app/issues/19');
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(state)));
  await settle(() => button('Inspect and use existing URL').click());
  const [path, input] = fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit];
  expect(path).toBe('/api/publication/reconcile-url');
  expect(JSON.parse(input.body as string)).toMatchObject({ operationId: 'create:0', url: 'https://github.com/team/app/issues/19' });
});

test('keyboard Escape cancels without a write and returns focus to the opener', async () => {
  await mount();
  const opener = document.createElement('button'); opener.textContent = 'Publish'; document.body.append(opener); opener.focus();
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(state)));
  await settle(() => usePublicationStore.getState().open('work'));
  await settle(() => vi.advanceTimersByTime(0));
  expect($('[role="dialog"]')!.contains(document.activeElement)).toBe(true);
  await settle(() => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  await settle(() => vi.advanceTimersByTime(0));
  expect($('[data-publication-dialog]')).toBeNull();
  expect(document.activeElement).toBe(opener);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test('a lost approval response blocks another submission until the durable journal is inspected', async () => {
  await mount();
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(state)));
  await settle(() => usePublicationStore.getState().open('work'));
  fetchMock.mockRejectedValueOnce(new Error('Lost response.'));
  await settle(() => button('Approve publication').click());
  expect(text(document.body)).toContain("Can't reach the board server");
  expect(button('Approve publication').disabled).toBe(true);
  const before = fetchMock.mock.calls.length;
  await settle(() => button('Approve publication').click());
  expect(fetchMock).toHaveBeenCalledTimes(before);
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(state)));
  await settle(() => button('Refresh journal').click());
  expect(button('Approve publication').disabled).toBe(false);
});

test('a refused body edit previews its exact fallback comment and needs a separate approval', async () => {
  await mount();
  const bodyOp: PublicationPlan['operations'][number] = { operationId: 'body', ticketWorkId: 'work-0', dependsOn: [], kind: 'append', content: 'Exact addition.', expectedText: '', location: { kind: 'body', start: 0, end: 0 } };
  const refused = { ...state, pending: { ...state.pending!, plan: { ...plan, approval: { approvedBy: 'board user', approvedAt: '', digest: plan.digest }, operations: [bodyOp], results: [{ operation: bodyOp, status: 'failed', attempt: { evidence: 'Body edit refused.' } }] }, failed: ['body'] } };
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(refused)));
  await settle(() => usePublicationStore.getState().open('work'));
  expect(text($('[data-publication-result="failed"]'))).toContain('Refused');
  const comment = { kind: 'comment', operationId: 'fallback', ticketWorkId: 'work-0', dependsOn: [], content: 'Complete separately approved fallback.' };
  const fallback = { ...state, pending: { ...state.pending!, plan: { ...plan, planId: 'fallback-plan', digest: 'fallback-digest', operations: [comment], results: [{ operation: comment, status: 'pending', attempt: null }] } } };
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(fallback)));
  await settle(() => button('Preview new comment').click());
  expect(fetchMock.mock.calls.at(-1)![0]).toBe('/api/publication/fallback');
  expect(text($('[data-refined-addition]'))).toBe('Complete separately approved fallback.');
  expect(fetchMock).toHaveBeenCalledTimes(2);
  let finish!: (response: Response) => void;
  fetchMock.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  await settle(() => button('Approve publication').click());
  expect(button('Approve publication').disabled).toBe(true);
  expect(button('Cancel').disabled).toBe(true);
  expect(text($('[role="status"]'))).toContain('Wait for its stored outcome');
  await settle(() => finish(new Response(JSON.stringify({ error: 'Comment access refused.' }), { status: 409 })));
  expect(text(document.body)).toContain('Comment access refused.');
  expect(button('Cancel').disabled).toBe(false);
});

test('a later publication shows the exact recorded location and a textual before-and-after diff', async () => {
  await mount();
  const operation: PublicationPlan['operations'][number] = { kind: 'replace-comment', operationId: 'update', ticketWorkId: 'work-0', dependsOn: [], location: { kind: 'comment', commentId: '37' }, expectedText: 'Find names.\nKeep checks.', content: 'Find prefixes.\nKeep checks.' };
  const updated = { ...state, pending: { ...state.pending!, plan: { ...plan, operations: [operation], results: [{ operation, status: 'pending', attempt: null }] } } };
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(updated)));
  await settle(() => usePublicationStore.getState().open('work'));
  expect(text(document.body)).toContain('Location: comment 37');
  expect(text($('[data-publication-before]'))).toBe('Find names.\nKeep checks.');
  expect(text($('[data-publication-diff] del'))).toBe('Find names.\n');
  expect(text($('[data-publication-diff] ins'))).toBe('Find prefixes.\n');
  expect(text($('[data-refined-addition]'))).toBe('Find prefixes.\nKeep checks.');
});

test('an outdated gate keeps the publication journal accessible for recovery', async () => {
  await mount();
  const item = { ...sample.items[0]!, publication: { eligible: false, recoverable: true, reasons: ['The changed brief needs a new gate.'] } };
  await settle(() => root.render(createElement(PublishButton, { item, data: useBoardStore.getState().data })));
  expect(button('Publish').disabled).toBe(false);
});

test('build documents require completion checks before preview and after clearing them', async () => {
  await mount();
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ...state, pending: null,
    sources: [{ workId: 'work', revision: 1, title: 'Search', repository: 'team/app', kind: 'build', body: 'Private brief.' }],
    settings: [{ setup: { repo: 'team/app', ...effectiveVocabulary({}), consent: [], paused: [], access: {} }, discovery: { provider: 'github', types: { state: 'available', choices: [] }, labels: { state: 'available', choices: [] } } }] })));
  await settle(() => usePublicationStore.getState().open('work'));
  await settle(() => usePublicationStore.getState().editDocument('work', { outcome: 'Find searches.', change: 'Add a filter.' }));
  expect(button('Preview publication').disabled).toBe(true);
  expect(text(document.body)).toContain('Required for builds');
  await settle(() => usePublicationStore.getState().editDocument('work', { checks: ['A named search is found.'] }));
  expect(button('Preview publication').disabled).toBe(false);
  await settle(() => usePublicationStore.getState().editDocument('work', { checks: ['   '] }));
  expect(button('Preview publication').disabled).toBe(true);
});

test('cross-repository child links preview the parent write permission', async () => {
  await mount();
  const operation: PublicationPlan['operations'][number] = { kind: 'relationship', operationId: 'child', ticketWorkId: 'work-1', relatedWorkId: 'work-0', relationship: 'child', dependsOn: [] };
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ...state, settings: [
    { setup: { repo: 'team/app', consent: [], access: { 'relate-ticket': 'refused' } } },
    { setup: { repo: 'team/api', consent: ['relate-ticket'], access: {} } },
  ], pending: { ...state.pending!, plan: { ...plan, operations: [operation] } } })));
  await settle(() => usePublicationStore.getState().open('work'));
  expect(text($('[data-publication-operation]'))).toContain('Write repository: team/app. Permissions: relate-ticket: Refused');
});

test("the preview shows a Dependency's request, its link step and its handover, without offering to attach the team's ticket", async () => {
  await mount();
  const request = { workId: 'dependency-1', dependencyOf: 'work-0', title: 'Search endpoint name filter', body: '## Change\n\nAdd a name filter.', destination: { provider: 'github' as const, repository: 'other/api' }, vocabulary: {}, typeResolution: { candidates: [], selected: null } };
  const operations: PublicationPlan['operations'] = [{ operationId: 'create:dependency-1', kind: 'create', ticketWorkId: 'dependency-1', dependsOn: [] },
    { operationId: 'blocked-by:work-0:dependency-1', kind: 'relationship', ticketWorkId: 'work-0', relatedWorkId: 'dependency-1', relationship: 'blocked-by', dependsOn: ['create:dependency-1'] }];
  const preview = { ...state, handover: '# Search endpoint name filter\n\n## Change\n\nAdd a name filter.\n', pending: { ...state.pending!, plan: { ...plan, tickets: [plan.tickets[0]!, request], operations } } };
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(preview)));
  await settle(() => usePublicationStore.getState().open('work'));
  expect(text($('[data-dependency-request]'))).toContain('Their ticket gets this request once.');
  expect(text($('[data-dependency-link]'))).toContain('"Depends on" line');
  expect(text(document.body)).toContain("other/api. It isn't onboarded");
  expect($$('[data-publication-operation]').map(text)[1]).toContain('blocked-by Search endpoint name filter');
  expect(text(document.body)).toContain('Posted ticket URL for Search 0');
  expect(text(document.body)).not.toContain('Posted ticket URL for Search endpoint name filter');
});
