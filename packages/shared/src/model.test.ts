import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inRepo, itemRepoNames, onAzure, repoTag, shownRepo, blockedText, blockerRef, dependencyNotice, buildBranch, buildMessage, canAbandon, checkState, failedCheck, ghBlocksRead, itemSource, isBuild, itemPr, itemTotal, isRecentlyDone, isSlow, isStale, itemName, ref, kindLabel, labelKind, labelStatuses, openBlockers, repoKey, repoName, onboardingConfigFile, providerTool, repositoryProjectHint, sameRepo, skillRenameProblem, startHold, sliceProgress, statusLabel, threadLink, usesGh, workMessage, workTitle } from './model.ts';
import type { BoardData, Blocker, Checks, DependencyHold, DependencyObservationKind, Item, Status } from './model.ts';
import { boardSections } from './board-view.ts';
import { validateDraft } from './add-item.ts';
import { day, formatTokens, formatUsd, shortAgo } from './format.ts';

function item(status: Status, labels: string[] = [], extra: Partial<Item> = {}): Item {
  return {
    id: 'x',
    revision: 0,
    status,
    statuses: status === 'Done' ? [] : [status],
    kind: labelKind(labels),
    content: 'ticket',
    number: 7,
    title: 't',
    url: 'https://github.com/maddec01/lar-server/issues/7',
    repo: 'maddec01/lar-server',
    labels,
    state: 'open',
    closedAs: null,
    parent: null,
    parentId: null,
    subIssues: { total: 0, completed: 0 },
    blockers: [],
    updatedAt: '2026-10-21T09:00:00Z',
    closedAt: null,
    linkedPrs: [],
    slices: [],
    ...extra,
  };
}

test('a slice ticket is done once closed as completed, else waiting; not planned is hidden', () => {
  assert.equal(sliceProgress('CLOSED', 'COMPLETED'), 'done');
  assert.equal(sliceProgress('CLOSED', null), 'done', 'closed before GitHub kept a reason');
  assert.equal(sliceProgress('OPEN', 'REOPENED'), 'waiting');
  assert.equal(sliceProgress('CLOSED', 'NOT_PLANNED'), null);
  assert.equal(sliceProgress('CLOSED', 'DUPLICATE'), null, 'a duplicate is closed as not planned too');
});

test("a ticket's labels give its kind", () => {
  assert.equal(labelKind(['bug', 'concept']), 'concept');
  assert.equal(labelKind([]), 'issue');
  assert.equal(labelKind(['improvement', 'build']), 'improvement', 'build only switches on slices');
  assert.equal(labelKind(['build', 'bug']), 'bug');
  assert.equal(labelKind(['build', 'feature']), 'feature');
  assert.equal(labelKind(['build']), 'build', 'with no other kind it reads as a build');
  assert.equal(labelKind(['build', 'decision-research']), 'decision');
  assert.equal(labelKind([['decision:', 'grill'].join(' ')]), 'issue', 'the old decision label is no kind');
  assert.equal(kindLabel(item('List', ['decision-task'])), 'decision-task');
  assert.equal(kindLabel(item('List', [], { kind: 'decision' })), 'decision', 'a recorded decision with no ticket label is a decision');
});

test('the build label makes a build whatever the kind, except on a concept', () => {
  assert.equal(isBuild(item('List', ['build'])), true);
  assert.equal(isBuild(item('List', ['build', 'feature'])), true);
  assert.equal(isBuild(item('List', ['feature'])), false);
  assert.equal(isBuild(item('List', ['build', 'concept'])), false, "a concept's sub-issues are board items, not slices");
});

test("an item's open blockers are the blocked-by issues still open", () => {
  const blockers = [{ number: 3, repo: 'maddec01/lar-server', state: 'closed' as const }, { number: 4, repo: 'maddec01/lar-apple', state: 'open' as const }];
  assert.deepEqual(openBlockers(item('Ready', [], { blockers })), [blockers[1]]);
});

test("the blocked text names the blockers whose work isn't complete, with the repository when it is another", () => {
  const blocker = (number: number, repo: string, state: 'open' | 'closed') => ({ number, repo, state });
  assert.equal(blockedText(item('Ready', [], { blockers: [blocker(3, 'maddec01/lar-server', 'open')] })), 'Blocked by #3 until it completes');
  assert.equal(blockedText(item('Ready', [], { blockers: [blocker(3, 'maddec01/lar-server', 'open'), blocker(4, 'maddec01/lar-apple', 'open')] })),
    'Blocked by #3, maddec01/lar-apple#4 until they complete');
  assert.equal(blockedText(item('Ready', [], { blockers: [blocker(3, 'maddec01/lar-server', 'closed')] })), null);
});

test("a blocker's ref is #n for the item's repository, and names another repository in full, or without its owner when short", () => {
  const own = item('Ready', []);
  assert.deepEqual([blockerRef(own, { number: 3, repo: own.repo! }), blockerRef(own, { number: 3, repo: own.repo! }, true)], ['#3', '#3']);
  assert.deepEqual([blockerRef(own, { number: 4, repo: 'maddec01/lar-apple' }), blockerRef(own, { number: 4, repo: 'maddec01/lar-apple' }, true)],
    ['maddec01/lar-apple#4', 'lar-apple#4']);
});

/** A Dependency on the server team's blocker, met when `met` is, its ticket last read as `kind`. */
function dependency(kind: DependencyObservationKind, met = false, change: Partial<DependencyHold> = {}): Blocker {
  const hold: DependencyHold = { dependencyId: 'd1', revision: 2, owner: 'server team', need: 'An export endpoint', ticket: 'maddec01/lar-server#40',
    named: [], evidence: 'The endpoint answers in staging', met: met ? { by: 'pedro', at: '2026-10-30T10:00:00Z' } : null, needsReview: false,
    observation: { subject: 'maddec01/lar-server#40', kind, detail: null, observedAt: '2026-10-30T09:00:00Z', lastGood: null }, ...change };
  return { number: 40, repo: 'maddec01/lar-server', state: met ? 'closed' : 'open', title: hold.need, dependency: hold };
}

test("an unmet Dependency holds the start whatever its ticket shows, and a met one doesn't", () => {
  const unmet = dependency('closed');
  assert.deepEqual(openBlockers(item('Ready', [], { blockers: [unmet, dependency('open', true)] })), [unmet]);
  assert.equal(blockedText(item('Ready', [], { blockers: [unmet] })), 'Blocked by the Dependency on server team until you mark it met');
  assert.equal(blockedText(item('Ready', [], { blockers: [{ number: 3, repo: 'maddec01/lar-server', state: 'open' }, unmet] })),
    'Blocked by #3 until it completes, and by the Dependency on server team until you mark it met');
  assert.equal(blockedText(item('Ready', [], { blockers: [dependency('open', true)] })), null);
});

test('a Dependency goes by its owner, never its ticket number', () => {
  const own = item('Ready', []);
  assert.deepEqual([blockerRef(own, dependency('open')), blockerRef(own, dependency('open'), true)], ['Dependency on server team', 'server team']);
});

test('a closed ticket or merged PR suggests marking it met, and a changed observation after the mark asks for a review', () => {
  assert.equal(dependencyNotice(dependency('closed').dependency!), 'Its ticket maddec01/lar-server#40 is closed. Mark it met once the change is delivered.');
  assert.equal(dependencyNotice(dependency('merged', false, { observation: { subject: 'maddec01/lar-server#41', kind: 'merged', detail: null, observedAt: '2026-10-30T09:00:00Z', lastGood: null } }).dependency!),
    'Its PR maddec01/lar-server#41 is merged. Mark it met once the change is delivered.');
  assert.equal(dependencyNotice(dependency('open').dependency!), null);
  assert.equal(dependencyNotice(dependency('closed', true).dependency!), null, 'a met Dependency needs no suggestion');
  assert.equal(dependencyNotice(dependency('reopened', true, { needsReview: true }).dependency!),
    'Its ticket maddec01/lar-server#40 changed to reopened after you marked it met. Review the mark.');
});

test('an item with a ticket goes by its number, and captured work with none by its title, never #0', () => {
  const ticketed = item('List', [], { number: 12, title: 'Index files' });
  const captured = item('List', [], { number: 0, title: 'Index files' });
  assert.deepEqual([ref(ticketed), itemName(ticketed)], ['#12', '#12 Index files']);
  assert.deepEqual([ref(captured), itemName(captured)], ['Index files', 'Index files']);
});

test("a repository's project hint is found whatever the case, and is null once T3 has its project or before any read", () => {
  const repositoryProjects = { 'maddec01/lar-server': 'Add the checkout in T3 Code', 'maddec01/lar-factory': null };
  assert.equal(repositoryProjectHint({ repositoryProjects }, 'MADDEC01/Lar-Server'), 'Add the checkout in T3 Code');
  assert.equal(repositoryProjectHint({ repositoryProjects }, 'maddec01/lar-factory'), null);
  assert.equal(repositoryProjectHint({}, 'maddec01/lar-server'), null);
});

test("a start in a repository still onboarding waits for its PR, whatever the case; else the project's hint holds it", () => {
  const onboarding = [{ repo: 'maddec01/lar-docs', progress: { step: 'pr', done: ['project'], answers: { projectId: 'p1' } } }];
  const repositoryProjects = { 'maddec01/lar-server': 'Add the checkout in T3 Code' };
  assert.equal(startHold({ onboarding, repositoryProjects }, 'MADDEC01/Lar-Docs'), "Waits for onboarding to finish");
  assert.equal(startHold({ onboarding, repositoryProjects }, 'maddec01/lar-server'), 'Add the checkout in T3 Code');
  assert.equal(startHold({ onboarding, repositoryProjects }, 'maddec01/lar-factory'), null);
  assert.equal(startHold({}, null), null);
});

test('Done counts for 7 days after closing', () => {
  const now = Date.parse('2026-10-21T10:00:00Z');
  assert.equal(isRecentlyDone(item('Done', [], { closedAt: '2026-10-15T10:00:00Z' }), now), true);
  assert.equal(isRecentlyDone(item('Done', [], { closedAt: '2026-10-13T10:00:00Z' }), now), false);
  assert.equal(isRecentlyDone(item('Review', [], { closedAt: '2026-10-21T09:00:00Z' }), now), false);
});

test('the work message titles the thread, then runs lar-shape on the work ID', () => {
  const work = item('Queued', [], { id: '0b6e2c1a-5d4f-4e3b-9a7c-1f2e3d4c5b6a' });
  assert.equal(workMessage(work), '#7 t\n$lar-shape 0b6e2c1a-5d4f-4e3b-9a7c-1f2e3d4c5b6a');
  assert.equal(workTitle(work), '#7 t');
});

test('the work message for ticketless work titles the thread with its title alone', () => {
  const work = item('Queued', [], { id: 'w1', number: 0, url: null, title: 'Tidy the docs' });
  assert.equal(workMessage(work), 'Tidy the docs\n$lar-shape w1');
});

test('a $word in the title is kept and $lar-shape still opens line 2', () => {
  const message = workMessage(item('Queued', [], { title: 'Fix $foo parsing' }))!;
  assert.equal(message, '#7 Fix $foo parsing\n$lar-shape x');
  assert.equal(message.split('\n')[1], '$lar-shape x');
});

test('a build branch is <kind>/<n>-<slug>: fix for a bug, feat for a feature or improvement, else chore', () => {
  const title = 'Add Start build to the board server';
  assert.equal(buildBranch(item('Ready', ['bug'], { title })), 'fix/7-add-start-build-to-the');
  assert.equal(buildBranch(item('Ready', ['feature'], { title })), 'feat/7-add-start-build-to-the');
  assert.equal(buildBranch(item('Ready', ['improvement', 'build'], { title })), 'feat/7-add-start-build-to-the');
  assert.equal(buildBranch(item('Ready', ['build'], { title })), 'chore/7-add-start-build-to-the');
  assert.equal(buildBranch(item('Ready', [], { title })), 'chore/7-add-start-build-to-the');
});

test('a build branch slug takes up to five words of the title, lowercase, with what a branch name cannot hold left out', () => {
  const branch = (title: string) => buildBranch(item('Ready', ['bug'], { title }));
  assert.equal(branch('Crash'), 'fix/7-crash');
  assert.equal(branch('Fix login'), 'fix/7-fix-login');
  assert.equal(branch("  Board: don't  read ~/.t3 [twice]?  "), 'fix/7-board-dont-read-t3-twice');
  assert.equal(branch('Fix `t3` CLI\'s path..lock @{ref} ^ * : \\ end'), 'fix/7-fix-t3-clis-path-lock');
  assert.equal(branch('Café crème über naïve'), 'fix/7-cafe-creme-uber-naive');
  assert.equal(branch('日本語 title 🚀 here'), 'fix/7-title-here');
  assert.equal(branch('日本語 🚀'), 'fix/7');
});

test('a ticketless build branch starts its slug with the first 8 characters of the work ID', () => {
  const work = item('Ready', ['bug'], { id: '0b6e2c1a-5d4f-4e3b-9a7c-1f2e3d4c5b6a', number: 0, url: null, title: 'Fix login' });
  assert.equal(buildBranch(work), 'fix/0b6e2c1a-fix-login');
});

test('the build message names the build by its work ID and the builder agent of the installed lar-build', () => {
  assert.equal(buildMessage(item('Ready', [], { id: 'w1' }), '/Users/me/.agents/skills/lar-build'),
    'Build w1. Read /Users/me/.agents/skills/lar-build/agents/builder.md and follow it.');
});

test('an item total adds each sub-issue on the board once, at any depth, and is null when sub-issues add nothing', () => {
  const repo = 'maddec01/lar-server';
  const under = (n: number) => ({ number: n, title: 't', url: `https://github.com/${repo}/issues/${n}`, repo: 'Maddec01/Lar-Server', state: 'open' as const });
  const parent = item('In progress', [], { id: 'p', number: 7, stats: { agentMs: 10, wallMs: 1, tokens: 100, costUsd: 0.5 } });
  const build = item('Done', ['build'], { id: 'b', number: 8, parent: under(7), parentId: 'p', stats: { agentMs: 20, wallMs: 2, tokens: 200, costUsd: 3, frozen: true } });
  const nested = item('Done', ['build'], { id: 'n', number: 9, parent: under(8), parentId: 'b', stats: { agentMs: 40, tokens: 400, costUsd: 5, frozen: true } });
  const quiet = item('Ready', [], { id: 'q', number: 10, parent: under(7), parentId: 'p' });
  const other = item('Done', [], { id: 'o', number: 11, repo: 'maddec01/lar-apple', parent: under(7), parentId: 'p', stats: { agentMs: 1, tokens: 1 } });
  const items = [parent, build, nested, quiet, other];
  assert.deepEqual(itemTotal(parent, items), { agentMs: 71, tokens: 701, costUsd: 8.5 },
    'wall only when every figure has it, frozen only when all are');
  assert.deepEqual(itemTotal(build, items), { agentMs: 60, tokens: 600, costUsd: 8, frozen: true });
  assert.equal(itemTotal(nested, items), null, 'no sub-issues: the total equals the item stats');
  assert.equal(itemTotal(quiet, items), null);
  assert.equal(itemTotal(parent, [parent, quiet]), null, 'sub-issues without figures add nothing');
  assert.equal(itemTotal(parent, [parent, { ...quiet, stats: { agentMs: 0, wallMs: 0, tokens: 0, costUsd: 0 } }, { ...other, stats: { agentMs: 0, tokens: 0 } }]), null,
    'sub-issues with all-zero figures leave the total equal to the item stats');
  assert.deepEqual(itemTotal(item('Queued', [], { id: 'p', number: 7 }), [build]),
    { agentMs: 20, wallMs: 2, tokens: 200, costUsd: 3, frozen: true }, 'a parent without its own figures totals its sub-issues');
  const looped = { ...parent, parent: under(8), parentId: 'b' };
  assert.deepEqual(itemTotal(looped, [looped, build, build]), { agentMs: 30, wallMs: 3, tokens: 300, costUsd: 3.5 },
    'each item counts once, even listed twice or in a loop');
  assert.equal(itemTotal(parent, [parent, { ...build, stats: 'unavailable' }]), 'unavailable', 'an unreadable figure leaves the total unknown');
  assert.equal(itemTotal({ ...parent, stats: 'unavailable' }, [build]), 'unavailable');
});

const sample = JSON.parse(readFileSync(new URL('../test/sample.json', import.meta.url), 'utf8')) as BoardData;

test('stale when the last read failed or is too old', () => {
  const fresh = { ...sample, error: null, fetchedAt: '2026-10-21T09:59:00Z' };
  assert.equal(isStale(sample, Date.parse('2026-10-21T09:41:00Z')), true);
  assert.equal(isStale(fresh, Date.parse('2026-10-21T10:00:00Z')), false);
  assert.equal(isStale(fresh, Date.parse('2026-10-21T10:30:00Z')), true);
  assert.equal(isStale({ ...sample, error: null, fetchedAt: null }, Date.parse('2026-10-21T10:30:00Z')), false, 'a first read still running is not stale');
  assert.equal(isStale({ ...sample, error: 'HTTP 502', fetchedAt: null }, Date.parse('2026-10-21T10:30:00Z')), true);
});

test('sample covers every status and both repositories', () => {
  const statuses = new Set(sample.items.map((i) => i.status));
  assert.equal(statuses.size, 10);
  const repos = new Set(sample.items.map((i) => i.repo));
  assert.ok(repos.has('maddec01/lar-server') && repos.has('maddec01/lar-apple'));
  const { needsYou, inFlight, queued, list } = boardSections(sample, Date.parse('2026-10-21T10:00:00Z'));
  assert.deepEqual([sample.items.length, needsYou.length, inFlight.length, queued.length, list.length], [28, 8, 8, 3, 4]);
});

test('the desk holds Ready, Needs you, Verify and Ready to merge, in flow order, and no concepts', () => {
  const now = Date.parse('2026-10-21T10:00:00Z');
  const items = [item('Verify'), item('Ready'), item('Ready', ['concept']), item('Needs you', ['concept']), item('Ready to merge'), item('Needs you'), item('In progress')]
    .map((i, n) => ({ ...i, id: `i${n}` }));
  const { needsYou } = boardSections({ ...sample, items }, now);
  assert.deepEqual(needsYou.map((i) => i.status), ['Needs you', 'Ready', 'Verify', 'Ready to merge']);
  assert.ok(boardSections(sample, now).needsYou.some((i) => i.status === 'Ready' && i.parent), 'a build sub-issue in Ready is on the desk');
});

test('the sample has a Verify item in each merge state', () => {
  const verify = sample.items.filter((i) => i.status === 'Verify');
  assert.deepEqual(new Set(verify.map((i) => itemPr(i)?.pipeline?.mergeState)), new Set(['can merge', 'checking', 'blocked', 'conflicts']));
  assert.ok(verify.some((i) => itemPr(i)?.pipeline && !itemPr(i)!.pipeline!.checks), 'one has no checks');
});

test('token counts are compact as on T3 Code\'s usage page', () => {
  assert.deepEqual([0, 980, 1_000, 1_234, 40_200, 312_400, 999_999, 1_200_000, 12_436_000, 2.5e9, 3e12].map(formatTokens),
    ['0', '980', '1K', '1.23K', '40.2K', '312K', '1000K', '1.20M', '12.4M', '2.50B', '3T']);
});

test('costs are shown as on T3 Code\'s usage page', () => {
  assert.deepEqual([0.004, 41.2, 1234.567].map(formatUsd), ['$0.00', '$41.20', '$1,234.57']);
});

test('a day shows its year only when that is not the current year, in the time zone it is read in', () => {
  const now = Date.parse('2026-10-26T12:00:00Z');
  assert.deepEqual([day('2026-10-19', 'UTC', now), day('2025-10-19', 'UTC', now), day('2027-01-02', 'UTC', now)],
    ['19 Oct', '19 Oct 2025', '2 Jan 2027']);
  assert.equal(day('2025-12-31T23:30:00Z', 'Europe/Amsterdam', Date.parse('2026-01-01T12:00:00Z')), '1 Jan');
});

test('a short age rounds each unit down, and a future time reads 0s ago', () => {
  const now = Date.parse('2026-10-23T12:00:00Z');
  const at = (s: number) => new Date(now - s * 1000).toISOString();
  assert.deepEqual([0, 59, 60, 59 * 60 + 59, 60 * 60, 47 * 3600 + 59 * 60, 48 * 3600, -30].map((s) => shortAgo(at(s), now)),
    ['0s ago', '59s ago', '1m ago', '59m ago', '1h ago', '47h ago', '2d ago', '0s ago']);
});

test("an item's PR is the one Open PR opens: its first linked PR", () => {
  const linked = (number: number, mergeState: 'can merge' | 'conflicts') => ({ number, url: `u${number}`, state: 'open' as const, isDraft: false, checks: null, mergeState });
  assert.deepEqual(itemPr(item('Verify', [], { linkedPrs: [linked(1, 'conflicts'), linked(2, 'can merge')] })), { url: 'u1', pipeline: linked(1, 'conflicts') });
  assert.equal(itemPr(item('Verify')), null, 'no PR, no link and no pipeline');
});

test('a running badge wins over failures until every check finishes, and turns slow after 30 minutes', () => {
  const now = Date.parse('2026-10-21T10:00:00Z');
  const checks = (c: Partial<Checks>): Checks => ({ passed: 0, failed: 0, running: 0, total: 0, since: null, ...c });
  assert.equal(checkState(checks({ passed: 1, running: 1, failed: 1, total: 3 })), 'running');
  assert.equal(checkState(checks({ passed: 2, failed: 1, total: 3 })), 'failed');
  assert.equal(checkState(checks({ passed: 3, total: 3 })), 'passed');
  assert.equal(checkState(null), null);
  assert.equal(isSlow(checks({ running: 1, total: 1, since: '2026-10-21T09:31:00Z' }), now), false);
  assert.equal(isSlow(checks({ running: 1, total: 1, since: '2026-10-21T09:30:00Z' }), now), true);
  assert.equal(isSlow(checks({ passed: 1, total: 1, since: '2026-10-21T08:00:00Z' }), now), false, 'only a running pipeline is slow');
  assert.equal(isSlow(checks({ running: 1, total: 1 }), now), false);
});

test('canAbandon takes List and Queued issues, never other statuses', () => {
  for (const status of ['List', 'Queued'] as const) {
    assert.ok(canAbandon(item(status)), `${status} issue`);
  }
  for (const status of ['Shaping', 'In progress', 'Done'] as const) assert.ok(!canAbandon(item(status)), status);
});

test('a thread link is T3 Code\'s threads deep link, each id one path segment', () => {
  assert.equal(threadLink('5e-8c5a', 'thread-1'), 't3code://threads/5e-8c5a/thread-1');
  assert.equal(threadLink('env', 'a/b c'), 't3code://threads/env/a%2Fb%20c');
});

test('failedCheck gives a failed check, and nothing for one that passed or before the first check', () => {
  const ok = { result: 'ok' } as const;
  const tools = { gh: { result: 'logged-out', fix: 'gh auth login' }, t3: { result: 'ok', version: '0.1.3' }, git: ok, jq: { result: 'missing', fix: 'brew install jq' }, curl: ok } as const;
  assert.deepEqual(failedCheck(tools, 'gh'), { result: 'logged-out', fix: 'gh auth login' });
  assert.deepEqual(failedCheck(tools, 'jq'), { result: 'missing', fix: 'brew install jq' });
  assert.equal(failedCheck(tools, 't3'), undefined);
  assert.equal(failedCheck(undefined, 'gh'), undefined);
});

test("a GitHub source reads with gh and an Azure DevOps one with az, and a list uses gh while any repository is on GitHub", () => {
  assert.deepEqual((['issues', 'azure-board'] as const).map(providerTool), ['gh', 'az']);
  assert.equal(usesGh([{ repo: 'contoso/web/api' }, { repo: 'maddec01/lar' }]), true);
  assert.equal(usesGh([{ repo: 'contoso/web/api' }]), false);
  assert.equal(usesGh([]), false);
});

test("a status's label is status- and its name in lowercase with hyphens for spaces", () => {
  assert.equal(statusLabel('Shaping'), 'status-shaping');
  assert.equal(statusLabel('Ready to merge'), 'status-ready-to-merge');
  assert.equal(statusLabel('Needs you'), 'status-needs-you');
});

test("an issue's labels hold the statuses whose labels it carries, in flow order, and never Done", () => {
  assert.deepEqual(labelStatuses(['bug', 'status-verify', 'status-shaping', 'status-done']), ['Shaping', 'Verify']);
  assert.deepEqual(labelStatuses(['bug']), []);
});

test('a repository goes by its name, or by owner/name when another board repository shares the name', () => {
  const repos = [{ repo: 'maddec01/lar-server', role: 'api', labels: [] }, { repo: 'maddec01/lar', role: 'app', labels: [] }, { repo: 'fabrikam/lar', role: 'app', labels: [] }];
  assert.equal(repoName('maddec01/lar-server', repos), 'lar-server');
  assert.equal(repoName('maddec01/lar', repos), 'maddec01/lar');
  assert.equal(repoName('fabrikam/lar', repos), 'fabrikam/lar');
  assert.equal(repoName('someone/elsewhere', repos), 'elsewhere', 'a repository off the board still goes by its name');
  const azure = [...repos, { repo: 'contoso/Fabrikam/lar-api', role: 'api', labels: [] }, { repo: 'contoso/Fabrikam/lar', role: 'app', labels: [] }];
  assert.equal(repoName('contoso/Fabrikam/lar-api', azure), 'lar-api', 'an Azure DevOps repository goes by its last part');
  assert.equal(repoName('contoso/Fabrikam/lar', azure), 'contoso/Fabrikam/lar');
  assert.equal(repoName('contoso/Fabrikam%20Fiber/lar', [...azure, { repo: 'contoso/Fabrikam%20Fiber/lar', role: 'app', labels: [] }]),
    'contoso/Fabrikam Fiber/lar', 'a shown key is decoded');
  assert.equal(repoName('contoso/Fabrikam/lar%20web', azure), 'lar web');
  assert.equal(repoKey(item('List')), 'maddec01/lar-server');
});

test('a repository shows with each part of its key decoded, and is on Azure DevOps when its key has three parts', () => {
  assert.equal(shownRepo('contoso/Fabrikam%20Fiber/lar-api'), 'contoso/Fabrikam Fiber/lar-api');
  assert.equal(shownRepo('maddec01/lar'), 'maddec01/lar');
  assert.equal(shownRepo('contoso/100%/lar'), 'contoso/100%/lar', 'a part that is no valid encoding shows as it is');
  assert.equal(onAzure('contoso/Fabrikam%20Fiber/lar-api'), true);
  assert.equal(onAzure('maddec01/lar'), false);
});

test('the board groups the List by repository, keyed by owner/name and named by name', () => {
  const repos = [{ repo: 'maddec01/lar', role: 'app', labels: [] }, { repo: 'fabrikam/lar', role: 'app', labels: [] }];
  const items = [item('List', [], { id: 'a', repo: 'fabrikam/lar' }), item('List', [], { id: 'c', repo: 'maddec01/lar' })];
  const groups = boardSections({ ...sample, repos, items }, Date.parse('2026-10-21T10:00:00Z')).listGroups;
  assert.deepEqual(groups.map((g) => [g.repo, g.name, g.items.map((i) => i.id)]), [
    ['maddec01/lar', 'maddec01/lar', ['c']], ['fabrikam/lar', 'fabrikam/lar', ['a']],
  ]);
});

test('the List groups repositories by their items in List, most first, ties in configured order', () => {
  const repos = ['o/a', 'o/b', 'o/c'].map((repo) => ({ repo, role: 'app', labels: [] }));
  const items = [
    item('List', [], { id: 'c1', repo: 'o/c' }), item('List', [], { id: 'c2', repo: 'o/c' }),
    item('List', [], { id: 'b1', repo: 'o/b' }), item('Queued', [], { id: 'b2', repo: 'o/b' }), item('Queued', [], { id: 'b3', repo: 'o/b' }),
  ];
  const groups = boardSections({ ...sample, repos, items }, Date.parse('2026-10-21T10:00:00Z')).listGroups;
  assert.deepEqual(groups.map((g) => [g.repo, g.items.length]), [['o/c', 2], ['o/b', 1], ['o/a', 0]]);
});

test("an untagged Azure work item shows in the List of every repository reading its item source, and a tagged one only in its repository's", () => {
  const repos = [{ repo: 'contoso/Fabrikam/web', role: 'app', labels: [] }, { repo: 'contoso/Fabrikam/api', role: 'api', labels: [] }];
  const items = [
    item('List', [], { id: 'a', repo: 'contoso/Fabrikam/web', untaggedFor: ['contoso/Fabrikam/web', 'contoso/Fabrikam/api'] }),
    item('List', [], { id: 'b', repo: 'contoso/Fabrikam/web' }),
  ];
  const groups = boardSections({ ...sample, repos, items }, Date.parse('2026-10-21T10:00:00Z')).listGroups;
  assert.deepEqual(groups.map((g) => [g.repo, g.items.map((i) => i.id)]), [['contoso/Fabrikam/web', ['a', 'b']], ['contoso/Fabrikam/api', ['a']]]);
  assert.equal(inRepo(items[0]!, 'Contoso/Fabrikam/API'), true);
  assert.equal(inRepo(items[1]!, 'contoso/Fabrikam/api'), false);
});

test("an item's repository name is its own repository's", () => {
  const repos = [{ repo: 'contoso/p/web', role: 'app', labels: [] }, { repo: 'contoso/p/api', role: 'api', labels: [] }];
  assert.equal(itemRepoNames({ repo: 'contoso/p/web' }, repos), 'web');
  assert.equal(itemRepoNames({ repo: 'contoso/p/api' }, repos), 'api');
});

test("an Azure work item's repository tag is repo- and the repository's name as Azure shows it", () => {
  assert.equal(repoTag('contoso/Fabrikam/WebShop'), 'repo-WebShop');
  assert.equal(repoTag('contoso/Fabrikam%20Fiber/Web%20Shop'), 'repo-Web Shop');
});

test("a repository's owner/name matches whatever its case, as GitHub's does, so a hand-written spelling still finds its items", () => {
  assert.equal(sameRepo('Maddec01/Lar-Factory', 'maddec01/lar-factory'), true);
  assert.equal(sameRepo('maddec01/lar-factory', 'maddec01/lar-server'), false);
  const repos = [{ repo: 'Maddec01/lar', role: 'app', labels: [] }, { repo: 'fabrikam/lar', role: 'app', labels: [] }];
  assert.equal(repoName('maddec01/lar', repos), 'maddec01/lar', 'the same repository in another case is not a second one');
  assert.equal(repoName('maddec01/lar', [{ repo: 'Maddec01/lar', role: 'app', labels: [] }]), 'lar');
  const items = [item('List', [], { id: 'a', repo: 'maddec01/lar' }), item('List', [], { id: 'b', repo: 'fabrikam/lar' })];
  const groups = boardSections({ ...sample, repos, items }, Date.parse('2026-10-21T10:00:00Z')).listGroups;
  assert.deepEqual(groups.map((g) => [g.repo, g.items.map((i) => i.id)]), [['Maddec01/lar', ['a']], ['fabrikam/lar', ['b']]]);
});

test('Add item keeps the title trimmed and the description as written, and nothing else the page sends', () => {
  const draft = { repo: 'maddec01/lar-server', kind: 'feature', title: ' Index files ', description: '## Why\nSearch.', labels: ['bug'] };
  assert.deepEqual(validateDraft(draft, sample.repos), { repo: 'maddec01/lar-server', kind: 'feature', title: 'Index files', description: '## Why\nSearch.' });
});

test('Add item refuses an unlisted repository, an unknown kind and a blank title', () => {
  const draft = { repo: 'maddec01/lar-server', kind: 'feature', title: 'Index files', description: '' };
  for (const input of [
    null, { ...draft, repo: 'other/repo' }, { ...draft, kind: 'concept' },
    { ...draft, title: ' \n ' }, { ...draft, title: 12 }, { ...draft, description: {} },
  ]) {
    assert.throws(() => validateDraft(input, sample.repos), /./, JSON.stringify(input));
  }
});

test('.lar-factory.json as onboarding writes it has the answers, version 2 and the custom labels the Labels step picked', () => {
  assert.equal(onboardingConfigFile({ itemSource: { kind: 'issues' }, role: 'Web client', labels: ['app: music', 'web'] }),
    '{\n  "version": 2,\n  "role": "Web client",\n  "itemSource": {\n    "kind": "issues"\n  },\n  "labels": [\n    "app: music",\n    "web"\n  ]\n}\n');
});

test('.lar-factory.json as Edit writes it keeps the version the file had', () => {
  const file = onboardingConfigFile({ itemSource: { kind: 'issues' }, role: 'API server', labels: [] }, 2);
  assert.deepEqual(JSON.parse(file), { version: 2, role: 'API server', itemSource: { kind: 'issues' }, labels: [] });
});

test('a skill Clash renames only to a valid name no bundled skill, no other project skill and no rename beside it has', () => {
  const bundled = ['code-review', 'tdd'];
  assert.equal(skillRenameProblem('web-review', bundled, ['code-review', 'ours'], ['web-tdd']), null);
  assert.match(skillRenameProblem('Web_Review', bundled, [], [])!, /lowercase letters, numbers and single hyphens/);
  assert.match(skillRenameProblem('..', bundled, [], [])!, /lowercase letters/);
  assert.equal(skillRenameProblem('tdd', bundled, [], []), 'tdd is already a bundled skill.');
  assert.equal(skillRenameProblem('ours', bundled, ['Ours'], []), 'A local skill already uses ours.');
  assert.equal(skillRenameProblem('web-skill', bundled, [], ['web-skill']), 'Another skill will use web-skill in this folder.');
});
