// Reads repository issues and linked PRs through the local `gh` CLI (`gh api graphql`).

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DONE_WINDOW_MS, buildSubIssueSearches, labelKind, normalizeItems, readBuilds, rawBuildPrs, rawDossiers, refKey } from '@lar-factory/shared';
import type { Item, PickedTicket, RawItem, RawLinkedPr, Searched, TicketMatch } from '@lar-factory/shared';
import { AccessLost, NotFound, type LegacyChild, type TicketObservation } from '../items/item-source.ts';
import { createCooldown } from '../tools/cooldown.ts';
import { runTool } from '../tools/run-tool.ts';
import { missingTool, toolCommand } from '../tools/tools.ts';

const PAGE_SIZE = 100;
const MAX_PAGES = 20;
/** Checks read per PR for the start time; the counts always cover all of them. */
const CHECK_SLICE = 20;
/** Blocked-by issues read per issue; the count covers every open one. */
const BLOCKER_LIMIT = 20;
/** A build's slices read per build; more than this is a build to split. */
const SLICE_LIMIT = 50;
/** Issues read per search page; a search pages up to GitHub's 1000 results. */
const SEARCH_PAGE_SIZE = 100;
const MAX_SEARCH_PAGES = 10;

/** A PR's checks: counts over all of them, and the first CHECK_SLICE for the start time. */
const CHECKS = `statusCheckRollup {
    contexts(first: ${CHECK_SLICE}) {
      checkRunCountsByState { state count }
      statusContextCountsByState { state count }
      nodes { ... on CheckRun { status startedAt checkSuite { createdAt } } ... on StatusContext { state createdAt } }
    }
  }`;

/** The fields the board reads of a repository issue. */
const ISSUE_FIELDS = `id number title url state stateReason closedAt updatedAt
  repository { nameWithOwner }
  labels(first: 20) { nodes { name } }
  assignees(first: 20) { nodes { login } }
  parent { number title url state repository { nameWithOwner } }
  subIssuesSummary { total completed }
  subIssues(first: ${SLICE_LIMIT}) { nodes { number title url state stateReason repository { nameWithOwner } } }
  blockedBy(first: ${BLOCKER_LIMIT}) { nodes { number state repository { nameWithOwner } } }
  closedByPullRequestsReferences(first: 5, includeClosedPrs: true) {
    nodes {
      id number url state isDraft mergeStateStatus
      ${CHECKS}
    }
  }`;

/** Issues by their node ids, up to PAGE_SIZE a call, for a read of a repository's active issues alone. */
const ISSUES_BY_ID_QUERY = `query($ids: [ID!]!) {
  nodes(ids: $ids) { ... on Issue { __typename ${ISSUE_FIELDS} } }
}`;

/** One page of a repository's open issues. */
export const OPEN_ISSUES_QUERY = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    issues(first: ${PAGE_SIZE}, after: $after, states: [OPEN]) {
      pageInfo { hasNextPage endCursor }
      nodes { __typename ${ISSUE_FIELDS} }
    }
  }
}`;

/** What decides whether the board keeps a closed issue: its close, its labels, and its parent's id and labels. */
const LIGHT_ISSUE_FIELDS = 'id closedAt stateReason labels(first: 20) { nodes { name } } parent { id labels(first: 20) { nodes { name } } }';

/** How many close-date ranges a repository's closed issues are searched in at once, mostly a page each: more calls at once answer slower. */
const CLOSED_RANGES = 10;

/**
 * One page of a search for a repository's issues closed in a close-date range, light. A light page answers in about half
 * the time of an OPEN_ISSUES_QUERY page, and the ranges search at once, where the issues connection pages one by one.
 */
const CLOSED_SEARCH_QUERY = `query($q: String!, $after: String) {
  search(type: ISSUE, first: ${SEARCH_PAGE_SIZE}, after: $after, query: $q) {
    pageInfo { hasNextPage endCursor }
    nodes { ... on Issue { ${LIGHT_ISSUE_FIELDS} } }
  }
}`;

/** A repository's issues closed and updated since `since`, the last updated first, light: one page, for those the search doesn't list yet. */
const RECENT_CLOSED_QUERY = `query($owner: String!, $name: String!, $since: DateTime) {
  repository(owner: $owner, name: $name) {
    issues(first: ${PAGE_SIZE}, states: [CLOSED], filterBy: { since: $since }, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes { ${LIGHT_ISSUE_FIELDS} }
    }
  }
}`;

/**
 * One page of an issue search, for the `build` label of the sub-issues off the read, which says whether one is a build
 * or a slice. Labels on every sub-issue in OPEN_ISSUES_QUERY cost 60 points a page, not 10; a search page costs 1.
 */
export const ISSUE_SEARCH_QUERY = `query($q: String!, $after: String) {
  search(type: ISSUE, first: ${SEARCH_PAGE_SIZE}, after: $after, query: $q) { pageInfo { hasNextPage endCursor } nodes { ... on Issue { number repository { nameWithOwner } } } }
}`;

/**
 * Dossiers' bodies, by issue node id, up to PAGE_SIZE ids a call. Only the body of a concept
 * or of an item with sub-issues on the board is read, for its map, so the board query skips
 * every other issue's body.
 */
export const DOSSIER_BODIES_QUERY = `query($ids: [ID!]!) {
  nodes(ids: $ids) { ... on Issue { id body } }
}`;

/**
 * Linked PRs' bodies and merge times, by PR node id, up to PAGE_SIZE ids a call. Only a build's merged stats and its
 * stats write-back read them, so the board query skips them on every other item's linked PRs.
 */
export const PR_BODIES_QUERY = `query($ids: [ID!]!) {
  nodes(ids: $ids) { ... on PullRequest { id body mergedAt } }
}`;

// ---------- raw GraphQL shapes ----------

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

/** An issue as ISSUE_SEARCH_QUERY reads it. */
interface SearchedIssue {
  number?: number;
  repository?: { nameWithOwner: string };
}

/** A closed issue as CLOSED_SEARCH_QUERY and RECENT_CLOSED_QUERY read it. */
interface LightIssue {
  id: string;
  closedAt: string | null;
  stateReason: string | null;
  labels: { nodes: { name: string }[] };
  parent: { id: string; labels: { nodes: { name: string }[] } } | null;
}

// ---------- gh ----------

type RateLimits = Record<string, { limit: number; remaining: number; reset: number }>;

/** GitHub's rate limits by resource, from its rate_limit endpoint, which costs no quota. */
const rateLimits = async (): Promise<RateLimits> => (JSON.parse(await gh(['api', 'rate_limit'], undefined, false)) as { resources: RateLimits }).resources;

/** When the exhausted rate limit resets, in ms since the epoch; null when none is exhausted, as after a secondary limit. */
async function ghReset(): Promise<number | null> {
  const resets = Object.values(await rateLimits()).filter((r) => r.remaining === 0).map((r) => r.reset * 1000);
  return resets.length ? Math.max(...resets) : null;
}

/** Whether less than a fifth of gh's REST or GraphQL quota is left, so the board keeps every source at its idle pace. */
export async function ghQuotaLow(): Promise<boolean> {
  const limits = await rateLimits();
  return ['core', 'graphql'].some((name) => limits[name] !== undefined && limits[name].remaining < limits[name].limit / 5);
}

/** gh's cooldown: once GitHub answers with a rate limit, every gh call fails at once until the limit resets. */
export const ghCooldown = createCooldown('gh', ghReset);

async function gh(args: string[], input?: string, cools = true): Promise<string> {
  const command = toolCommand('gh');
  if (!command) throw new Error(`${missingTool('gh')}. Install it with \`brew install gh\` or set GH_PATH.`);
  if (cools) ghCooldown.check();
  const result = await runTool(command.file, args, { env: command.env, input, timeout: 30_000, maxBuffer: 32 * 1024 * 1024 });
  if (result.code !== 0) {
    if (cools) await ghCooldown.failed(result.stderr || result.detail);
    throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${result.detail}`);
  }
  if (cools) ghCooldown.succeeded();
  return result.stdout;
}

export async function graphql<T>(query: string, vars: Record<string, string | number | string[] | null>, run: (args: string[]) => Promise<string> = gh): Promise<T> {
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [key, value] of Object.entries(vars)) {
    if (value === null) continue;
    if (Array.isArray(value)) args.push(...value.flatMap((v) => ['-f', `${key}[]=${v}`]));
    else args.push(typeof value === 'number' ? '-F' : '-f', `${key}=${value}`);
  }
  return JSON.parse(await run(args)) as T;
}

/** How far before its `since` a change check looks, so a clock behind GitHub's misses no change. */
const CLOCK_SKEW_MS = 30_000;
/** Whether something updated at `at`, as GitHub dates it, changed since `since`, in ms since the epoch. */
export const changedSince = (at: string, since: number) => Date.parse(at) >= since - CLOCK_SKEW_MS;

/** A REST answer and the ETag to ask for it again with. */
export interface Tagged<T> {
  etag: string | undefined;
  body: T;
}

/**
 * The JSON at a REST path, or null when it's unchanged since the answer `etag` tagged. GitHub answers an unchanged path
 * with a 304, which costs no quota, so a change check can ask every few seconds.
 */
export async function getIfChanged<T>(path: string, etag: string | undefined, run: (args: string[]) => Promise<string> = gh): Promise<Tagged<T> | null> {
  let out: string;
  try {
    out = await run(['api', '-i', ...(etag ? ['-H', `If-None-Match: ${etag}`] : []), path]);
  } catch (err) {
    if (/\b304\b/.test(message(err))) return null;
    throw err;
  }
  const split = /\r?\n\r?\n/.exec(out);
  const head = split ? out.slice(0, split.index) : '';
  return { etag: /^etag:\s*(.+?)\s*$/im.exec(head)?.[1], body: JSON.parse(split ? out.slice(split.index + split[0].length) : out) as T };
}

/**
 * A file's text on the branch, or on the repository's default branch when there is none, read through the contents
 * API; null when the branch has no such file.
 */
export async function readBranchFile(repo: string, path: string, branch?: string, run: (args: string[]) => Promise<string> = gh): Promise<string | null> {
  const ref = branch === undefined ? '' : `?ref=${encodeURIComponent(branch)}`;
  try {
    return await run(['api', `repos/${repo}/contents/${path}${ref}`, '-H', 'Accept: application/vnd.github.raw']);
  } catch (err) {
    if (/HTTP 404/.test(message(err))) return null;
    throw err;
  }
}

/** An authenticated GET of all pages of provider metadata. */
export async function githubJson(path: string, run: (args: string[]) => Promise<string> = gh): Promise<unknown> {
  return JSON.parse(await run(['api', '--method', 'GET', path, '--paginate', '--slurp']));
}

/** What gh's login may do in the repository, as its `permissions` say, and whether it has issues turned on. */
export async function repositoryAccess(repo: string, run: (args: string[]) => Promise<string> = gh): Promise<{ push: boolean; triage: boolean; issues: boolean }> {
  const { push, triage, issues } = JSON.parse(await run(['api', `repos/${repo}`, '--jq', '{push: .permissions.push, triage: .permissions.triage, issues: .has_issues}'])) as Record<string, unknown>;
  return { push: push === true, triage: triage === true, issues: issues === true };
}

/** Reads up to `maxPages` pages, each after the cursor the one before ended at; throws `tooMany` when there are more. */
async function readPages(maxPages: number, tooMany: string, readPage: (after: string | null) => Promise<PageInfo>): Promise<void> {
  let after: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const pageInfo = await readPage(after);
    if (!pageInfo.hasNextPage) return;
    after = pageInfo.endCursor;
  }
  throw new Error(tooMany);
}

/** Each issue an issue search finds, across its pages. */
async function searchPages<T>(q: string, query = ISSUE_SEARCH_QUERY): Promise<T[]> {
  const nodes: T[] = [];
  await readPages(MAX_SEARCH_PAGES, `Issue search "${q}" has more than ${SEARCH_PAGE_SIZE * MAX_SEARCH_PAGES} results; stopped paging`, async (after) => {
    const { search } = (await graphql<{ data: { search: { pageInfo: PageInfo; nodes: T[] } } }>(query, { q, after })).data;
    nodes.push(...search.nodes);
    return search.pageInfo;
  });
  return nodes;
}

/** The `repo#number` keys of the issues a search finds. */
async function searchIssues(q: string): Promise<Set<string>> {
  const keys = new Set<string>();
  for (const n of await searchPages<SearchedIssue>(q)) {
    if (n.repository && n.number) keys.add(refKey(n.repository.nameWithOwner, n.number));
  }
  return keys;
}

/** The `repo#number` keys the issue searches find together, each search in one repository; none for no search. */
type LabelSearch = (searches: readonly string[]) => Promise<Set<string>>;

/**
 * A LabelSearch for one read that runs each search once, so the read can start the ones it expects early and use
 * them when its items are all read.
 */
function searchOnce(): LabelSearch {
  const runs = new Map<string, Promise<Set<string>>>();
  return async (searches) => {
    const found = await Promise.all(searches.map((q) => {
      let run = runs.get(q);
      if (!run) {
        runs.set(q, (run = searchIssues(q)));
        // A search started early may fail before anything waits on it; the read that uses it fails then.
        run.catch(() => {});
      }
      return run;
    }));
    return new Set(found.flatMap((keys) => [...keys]));
  };
}

/**
 * Finds which of the builds' sub-issues are builds, from the read's own labels and a search of the rest. The board reads
 * no slice progress from tickets: a work record holds its slices' progress.
 */
async function searchBuilds(raws: RawItem[], search: LabelSearch): Promise<Searched> {
  return { builds: new Set([...readBuilds(raws), ...await search(buildSubIssueSearches(raws))]) };
}

/**
 * Puts each dossier's body on its raw item, for its map. The searches decide which sub-issues are slices, so which items
 * are dossiers: the bodies are read meanwhile for each item that is one when no sub-issue is a slice, and kept for the
 * dossiers alone.
 */
async function readDossierBodies(raws: RawItem[], searched: Promise<Searched>): Promise<void> {
  const contentOf = (dossiers: RawItem[]) => new Map(dossiers.flatMap((raw) => (raw.content ? [[raw.content.id, raw.content]] : [])));
  const everySubIssue = new Set(raws.flatMap((raw) => raw.content?.subIssues?.nodes ?? []).map((s) => refKey(s.repository.nameWithOwner, s.number)));
  const [bodies, found] = await Promise.all([
    fetchNodes<{ id?: string; body?: string }>(DOSSIER_BODIES_QUERY, [...contentOf(rawDossiers(raws, { builds: everySubIssue })).keys()]),
    searched,
  ]);
  const dossiers = contentOf(rawDossiers(raws, found));
  for (const node of bodies) {
    const content = node.id ? dossiers.get(node.id) : undefined;
    if (content) content.body = node.body ?? '';
  }
}

/** Puts each build's linked PRs' body and merge time on them, for the build's merged stats and its stats write-back. */
async function readBuildPrBodies(raws: RawItem[]): Promise<void> {
  // Two builds can link the same PR; it's read once.
  const prs = new Map<string, RawLinkedPr[]>();
  for (const pr of rawBuildPrs(raws)) if (pr.id) prs.set(pr.id, [...prs.get(pr.id) ?? [], pr]);
  const read = await fetchNodes<Pick<RawLinkedPr, 'body' | 'mergedAt'> & { id: string }>(PR_BODIES_QUERY, [...prs.keys()]);
  for (const { id, body, mergedAt } of read) for (const pr of prs.get(id) ?? []) Object.assign(pr, { body, mergedAt });
}

/**
 * The nodes with these ids, `size` ids a call, all calls at once; an id that no longer resolves fails the call, as gh
 * does on any GraphQL error.
 */
async function fetchNodes<T extends object>(query: string, ids: readonly string[], size = PAGE_SIZE): Promise<T[]> {
  const chunks = Array.from({ length: Math.ceil(ids.length / size) }, (_, i) => ids.slice(i * size, (i + 1) * size));
  const read = await Promise.all(chunks.map(async (chunk) => (await graphql<{ data: { nodes: (T | null)[] } }>(query, { ids: chunk })).data.nodes));
  return read.flat().filter((node): node is T => node !== null && Object.keys(node).length > 0);
}

/** The issues with these node ids, read afresh, each placed by its `status-<name>` labels. */
export async function fetchIssues(ids: readonly string[]): Promise<Item[]> {
  const issues = await fetchNodes<NonNullable<RawItem['content']>>(ISSUES_BY_ID_QUERY, ids);
  return boardItems(issues.map((content): RawItem => ({ id: content.id, updatedAt: content.updatedAt, content })));
}

/** The board's items from raw items, once all are read, without slices and with each dossier's map. */
async function boardItems(raws: RawItem[], search = searchOnce()): Promise<Item[]> {
  // A slice and its build can sit on different pages, so slices are dropped once all are read. The searches
  // decide which sub-issues are slices, so the dossiers, items with sub-issues on the board, are known once they land.
  const searching = searchBuilds(raws, search);
  const [searched] = await Promise.all([searching, readDossierBodies(raws, searching), readBuildPrBodies(raws)]);
  return normalizeItems(raws, searched);
}

/** Each page of a repository's issues the query reads, after the cursor the one before ended at. */
async function readRepoPages<T>(repo: string, what: string, query: string, vars: Record<string, string> = {}): Promise<T[]> {
  const [owner, name] = repo.split('/');
  const nodes: T[] = [];
  await readPages(MAX_PAGES, `${repo} has more than ${PAGE_SIZE * MAX_PAGES} ${what} to show; stopped paging`, async (after) => {
    const page = (await graphql<{ data: { repository: { issues: { pageInfo: PageInfo; nodes: T[] } } | null } }>(query,
      { owner: owner!, name: name!, ...vars, after })).data.repository?.issues;
    if (!page) throw new Error(`Repository ${repo} not found`);
    nodes.push(...page.nodes);
    return page.pageInfo;
  });
  return nodes;
}

const hasLabel = (labels: { nodes: { name: string }[] }, name: string) => labels.nodes.some((l) => l.name === name);

const notPlanned = (issue: LightIssue) => issue.stateReason === 'NOT_PLANNED' || issue.stateReason === 'DUPLICATE';

/**
 * Whether the board keeps a closed issue: one closed since `since`, unless it's a slice or closed as not planned. A
 * closed build stays even when not planned, since its card is dropped but its slices still are too. A sub-issue without
 * `build` of a `build` issue is a slice when its build is in the same read, which only the whole read tells: undefined.
 */
function keeps(issue: LightIssue, since: number): boolean | undefined {
  if (!issue.closedAt || Date.parse(issue.closedAt) < since) return false;
  const build = hasLabel(issue.labels, 'build');
  if (!build && issue.parent !== null && hasLabel(issue.parent.labels, 'build')) return undefined;
  return build || !notPlanned(issue);
}

/** The closed issues the board keeps, by id, once the read is whole: a slice whose build wasn't read stays. */
function keptClosed(closed: LightIssue[], openIds: ReadonlySet<string>, since: number): string[] {
  const read = new Set([...openIds, ...closed.filter((issue) => keeps(issue, since) !== false).map((issue) => issue.id)]);
  return closed.filter((issue) => keeps(issue, since) ?? (!read.has(issue.parent!.id) && !notPlanned(issue))).map((issue) => issue.id);
}

/** Issues read in full by id a call: a full issue is heavy, so 100 take about 4 s and four calls of 25 at once about 1 s. */
const FULL_ISSUES_SIZE = 25;

/** GitHub's search syntax for a time: to the second, in UTC. */
const searchTime = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * A repository's issues closed since `since`, light. The closed issues updated last fill one page, which holds them all
 * unless it's full; when it might miss some, they're searched in CLOSED_RANGES close-date ranges at once, the last open
 * ended, so a clock behind GitHub's misses none, and the page joins them, as the search index lags a close by seconds.
 * An issue updated since `since` may have closed before it, which keeps checks. `atOnce`, as on the source's first
 * read, searches the ranges alongside the page instead of waiting to see whether it's full. `onRead` gets each
 * search's issues, and the page's, as each lands.
 */
async function readClosed(repo: string, since: number, now: number, onRead: (issues: LightIssue[]) => void, atOnce: boolean): Promise<LightIssue[]> {
  const [owner, name] = repo.split('/');
  const step = (now - since) / CLOSED_RANGES;
  const ranges = Array.from({ length: CLOSED_RANGES }, (_, i) => {
    const from = searchTime(since + i * step);
    return i === CLOSED_RANGES - 1 ? `>=${from}` : `${from}..${searchTime(since + (i + 1) * step)}`;
  });
  const searchRanges = () => Promise.all(ranges.map((range) => searchPages<LightIssue>(`repo:${repo} is:issue is:closed closed:${range}`, CLOSED_SEARCH_QUERY)
    .then((issues) => (onRead(issues), issues))));
  const searching = atOnce ? searchRanges() : undefined;
  // A search started at once may fail while the page is read; the read fails once it waits on it.
  searching?.catch(() => {});
  const { data } = await graphql<{ data: { repository: { issues: { nodes: LightIssue[] } } | null } }>(RECENT_CLOSED_QUERY,
    { owner: owner!, name: name!, since: searchTime(since) });
  if (!data.repository) throw new Error(`Repository ${repo} not found`);
  const recent = data.repository.issues.nodes;
  onRead(recent);
  const searched = searching ?? (recent.length < PAGE_SIZE ? undefined : searchRanges());
  // Ranges share their ends, so an issue closed on one is found twice.
  return [...new Map([...recent, ...(await searched ?? []).flat()].map((issue) => [issue.id, issue])).values()];
}

/**
 * A repository's open issues, each placed by its `status-<name>` labels, and those closed in the last DONE_WINDOW_MS,
 * without slices. Closed issues are read light, and only the ones the board keeps are read in full. `searchRanges`, for
 * the source's first read, searches the closed issues' ranges at once, as readClosed's `atOnce` says.
 */
export async function fetchRepoIssues(repo: string, now = Date.now(), { searchRanges = false } = {}): Promise<Item[]> {
  type Content = NonNullable<RawItem['content']>;
  const asRaws = (issues: Content[]) => issues.map((content): RawItem => ({ id: content.id, updatedAt: content.updatedAt, content }));
  const since = now - DONE_WINDOW_MS;
  const search = searchOnce();
  // Each closed issue the board keeps whatever else the read holds is read in full as soon as its search lands.
  const asked = new Set<string>();
  const reads: Promise<Content[]>[] = [];
  const readInFull = (ids: string[]) => {
    for (const id of ids) asked.add(id);
    const read = fetchNodes<Content>(ISSUES_BY_ID_QUERY, ids, FULL_ISSUES_SIZE);
    // A read that fails before the closed ones are all read fails the read once it's waited on.
    read.catch(() => {});
    reads.push(read);
  };
  const [open, closed] = await Promise.all([
    // The open issues name most of the searches the read needs, so those start while the closed ones are read.
    readRepoPages<Content>(repo, 'open issues', OPEN_ISSUES_QUERY).then((issues) => {
      void searchBuilds(asRaws(issues), search).catch(() => {});
      return issues;
    }),
    readClosed(repo, since, now, (issues) => readInFull(issues.filter((issue) => keeps(issue, since) && !asked.has(issue.id)).map((issue) => issue.id)), searchRanges),
  ]);
  readInFull(keptClosed(closed, new Set(open.map((issue) => issue.id)), since).filter((id) => !asked.has(id)));
  const kept = (await Promise.all(reads)).flat();
  // One normalization over open and closed together, so a closed dossier keeps its map and a closed build drops its slices.
  return boardItems(asRaws([...open, ...kept]), search);
}

/** An error's message, for a write's error text. */
export const message = (err: unknown) => (err instanceof Error ? err.message : 'GitHub request failed.');

/** Replaces an issue's body, written to a file for gh's --body-file. */
export async function editIssueBody(repo: string, number: number, body: string, run: (args: string[]) => Promise<string> = gh): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'lar-body-'));
  try {
    const file = join(dir, 'body.md');
    await writeFile(file, body);
    await run(['issue', 'edit', String(number), '-R', repo, '--body-file', file]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A PR's REST path, `repos/<owner>/<repo>/pulls/<n>`, from its URL. */
function pullPath(url: string): string {
  const match = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)$/.exec(url);
  if (!match) throw new Error(`Not a pull request URL: ${url}`);
  return `repos/${match[1]}/pulls/${match[2]}`;
}

/** A PR's description as it is now, by the PR's URL; empty when it has none. */
export async function readPrBody(url: string, run: (args: string[]) => Promise<string> = gh): Promise<string> {
  const pr = JSON.parse(await run(['api', pullPath(url)])) as { body?: string | null };
  return pr.body ?? '';
}

/** Replaces a PR's description, by the PR's URL. */
export async function editPrBody(url: string, body: string, run: (args: string[]) => Promise<string> = gh): Promise<void> {
  // -f sends the body as a string as is; -F would read a body starting with @ as a file.
  await run(['api', '--method', 'PATCH', pullPath(url), '-f', `body=${body}`]);
}

/** The repository's default branch and the commit at its head. */
export async function defaultBranchHead(repo: string, run: (args: string[]) => Promise<string> = gh): Promise<{ branch: string; sha: string }> {
  const branch = (await run(['api', `repos/${repo}`, '--jq', '.default_branch'])).trim();
  const sha = (await run(['api', `repos/${repo}/git/ref/heads/${branch}`, '--jq', '.object.sha'])).trim();
  return { branch, sha };
}

/** A commit's tree: its own SHA, and each file's mode and blob SHA by path. */
export interface CommitTree {
  sha: string;
  files: Map<string, { mode: string; sha: string }>;
}

/** Every file in the commit's tree; throws when GitHub lists only part of them. */
export async function commitTree(repo: string, commit: string, run: (args: string[]) => Promise<string> = gh): Promise<CommitTree> {
  const { sha, truncated, tree } = JSON.parse(await run(['api', `repos/${repo}/git/trees/${commit}?recursive=1`])) as
    { sha: string; truncated: boolean; tree: { path: string; mode: string; type: string; sha: string }[] };
  if (truncated) throw new Error('GitHub listed only part of its files, since it has too many.');
  return { sha, files: new Map(tree.filter((entry) => entry.type === 'blob').map((entry) => [entry.path, { mode: entry.mode, sha: entry.sha }])) };
}

/** A blob's text, by its SHA. */
export async function readBlob(repo: string, sha: string, run: (args: string[]) => Promise<string> = gh): Promise<string> {
  return run(['api', `repos/${repo}/git/blobs/${sha}`, '-H', 'Accept: application/vnd.github.raw']);
}

/** A file a new tree writes with its text, keeps at a blob, or deletes when its `sha` is null. */
export type TreeEntry = { path: string; mode: string } & ({ content: string } | { sha: string | null });

/** Makes a tree on GitHub from `base` with the entries changed, and returns its SHA. */
export async function createTree(repo: string, base: string, entries: TreeEntry[],
  run: (args: string[], input?: string) => Promise<string> = gh): Promise<string> {
  const input = JSON.stringify({ base_tree: base, tree: entries.map((entry) => ({ ...entry, type: 'blob' })) });
  return (await run(['api', `repos/${repo}/git/trees`, '--method', 'POST', '--input', '-', '--jq', '.sha'], input)).trim();
}

/** Makes a commit on GitHub of the tree with one parent, and returns its SHA. */
export async function createCommit(repo: string, message: string, tree: string, parent: string,
  run: (args: string[]) => Promise<string> = gh): Promise<string> {
  return (await run(['api', `repos/${repo}/git/commits`, '--method', 'POST', '-f', `message=${message}`, '-f', `tree=${tree}`,
    '-f', `parents[]=${parent}`, '--jq', '.sha'])).trim();
}

/** Moves a branch on GitHub to the commit, even when the commit doesn't follow from it. */
export async function moveBranch(repo: string, branch: string, sha: string, run: (args: string[]) => Promise<string> = gh): Promise<void> {
  await run(['api', `repos/${repo}/git/refs/heads/${branch}`, '--method', 'PATCH', '-f', `sha=${sha}`, '-F', 'force=true']);
}

/** Makes a branch on GitHub at the commit, leaving every checkout alone. */
export async function createBranch(repo: string, branch: string, sha: string, run: (args: string[]) => Promise<string> = gh): Promise<void> {
  await run(['api', `repos/${repo}/git/refs`, '--method', 'POST', '-f', `ref=refs/heads/${branch}`, '-f', `sha=${sha}`]);
}

/**
 * Makes one commit on `parent` with the entries changed, with the Git data API, and puts `branch` on it: the branch is
 * made there, or moved there from its head whether or not the commit follows from it. azure-repos.ts's pushCommit does
 * the same on Azure Repos.
 */
export async function pushCommit(repo: string, branch: string, commit: { message: string; parent: string; entries: TreeEntry[] },
  run: (args: string[], input?: string) => Promise<string> = gh): Promise<void> {
  const [head, tree] = await Promise.all([branchHead(repo, branch, run), commitTree(repo, commit.parent, run)]);
  const sha = await createCommit(repo, commit.message, await createTree(repo, tree.sha, commit.entries, run), commit.parent, run);
  await (head === null ? createBranch : moveBranch)(repo, branch, sha, run);
}

/** The commit at the head of the repository's branch on GitHub, or null when it has no such branch. */
export async function branchHead(repo: string, branch: string, run: (args: string[]) => Promise<string> = gh): Promise<string | null> {
  try {
    return (await run(['api', `repos/${repo}/git/ref/heads/${branch}`, '--jq', '.object.sha'])).trim();
  } catch (err) {
    if (/HTTP 404/.test(message(err))) return null;
    throw err;
  }
}

/** Whether the repository has the branch on GitHub. */
export async function branchExists(repo: string, branch: string, run: (args: string[]) => Promise<string> = gh): Promise<boolean> {
  return await branchHead(repo, branch, run) !== null;
}

/** The URL of the open PR from the branch, or null when it has none. */
export async function openPrFrom(repo: string, branch: string, run: (args: string[]) => Promise<string> = gh): Promise<string | null> {
  const url = (await run(['pr', 'list', '-R', repo, '--head', branch, '--state', 'open', '--json', 'url', '--jq', '.[0].url // empty'])).trim();
  return url || null;
}

/** Opens a PR from `head` into `base` and returns its URL. */
export async function createPr(repo: string, pr: { base: string; head: string; title: string; body: string },
  run: (args: string[]) => Promise<string> = gh): Promise<string> {
  const out = await run(['pr', 'create', '-R', repo, '--base', pr.base, '--head', pr.head, '--title', pr.title, '--body', pr.body]);
  const url = out.trim().split('\n').at(-1) ?? '';
  if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(url)) throw new Error(`gh pr create sent no PR URL: ${out.trim()}`);
  return url;
}

/**
 * A gh read's error as GitHub meant it: AccessLost when it refused the signed-in account, NotFound for a PR it can't
 * resolve, or as it is. A repository it can't resolve may be deleted or hidden, so that error stays as it is.
 */
function refusalOf(err: unknown): unknown {
  const text = message(err);
  if (/HTTP 40[13]\b|Resource not accessible|SAML enforcement/i.test(text)) return new AccessLost(text);
  if (/Could not resolve to a PullRequest/i.test(text)) return new NotFound(text);
  return err;
}

/** Whether a PR, by its URL, is open, merged or closed without merging. Throws NotFound or AccessLost when GitHub says so. */
export async function prState(url: string, run: (args: string[]) => Promise<string> = gh): Promise<'OPEN' | 'MERGED' | 'CLOSED'> {
  let state: string;
  try { state = (await run(['pr', 'view', url, '--json', 'state', '--jq', '.state'])).trim(); }
  catch (err) { throw refusalOf(err); }
  if (state !== 'OPEN' && state !== 'MERGED' && state !== 'CLOSED') throw new Error(`gh pr view sent no PR state for ${url}: ${state}`);
  return state;
}

/** Closes a PR, by its URL, with a comment that says why. */
export async function closePr(url: string, comment: string, run: (args: string[]) => Promise<string> = gh): Promise<void> {
  await run(['pr', 'close', url, '--comment', comment]);
}

/** Reopens a PR, by its URL, that closed without merging. */
export async function reopenPr(url: string, run: (args: string[]) => Promise<string> = gh): Promise<void> {
  await run(['pr', 'reopen', url]);
}

/** Closes an issue as not planned; returns the error, or null when GitHub accepted it. */
export async function abandonIssue(item: Item, run: (args: string[]) => Promise<string> = gh): Promise<string | null> {
  try {
    await run(['issue', 'close', String(item.number), '-R', item.repo!, '--reason', 'not planned']);
    return null;
  } catch (err) {
    return `Could not abandon #${item.number}. ${message(err)}`;
  }
}

/** The open issues of `repo` whose words match `query`, as gh's issue search finds them, or the latest open ones for no words. */
export async function findIssues(repo: string, query: string, limit: number, run: (args: string[]) => Promise<string> = gh): Promise<TicketMatch[]> {
  const words = query.trim();
  const issues = JSON.parse(await run(['issue', 'list', '-R', repo, '--state', 'open', '--limit', String(limit), '--json', 'number,title,url',
    ...words ? ['--search', words] : []])) as TicketMatch[];
  return issues.map(({ number, title, url }) => ({ number, title, url }));
}

/** An open issue's title, body and kind; null when `repo` has no issue `number` or it is closed. */
export async function readIssue(repo: string, number: number, run: (args: string[]) => Promise<string> = gh): Promise<PickedTicket | null> {
  let issue: { number: number; title: string; url: string; body: string; labels: { name: string }[]; state: string };
  try {
    issue = JSON.parse(await run(['issue', 'view', String(number), '-R', repo, '--json', 'number,title,url,body,labels,state']));
  } catch (err) {
    if (/Could not resolve to an issue/.test(message(err))) return null;
    throw err;
  }
  if (issue.state !== 'OPEN') return null;
  return { number: issue.number, title: issue.title, url: issue.url, text: issue.body, kind: labelKind(issue.labels.map((l) => l.name)) };
}

/** Closed native parts preserve a selected concept's history without picking its unselected open work. */
export async function legacyIssueChildren(repo: string, number: number, run: (args: string[]) => Promise<string> = gh): Promise<LegacyChild[]> {
  const pages = JSON.parse(await run(['api', '--paginate', '--slurp', `repos/${repo}/issues/${number}/sub_issues?per_page=100`])) as {
    number: number; title: string; html_url: string; body: string | null; state: string; state_reason: string | null; labels: { name: string }[];
  }[][];
  const children: LegacyChild[] = [];
  for (const child of pages.flat()) {
    const labels = child.labels.map(label => label.name);
    if (child.state !== 'closed' || !labels.some(label => label === 'build' || label.startsWith('decision-'))) continue;
    if (child.html_url.toLowerCase() !== `https://github.com/${repo}/issues/${child.number}`.toLowerCase()) {
      throw new Error(`A closed part belongs to another repository (${child.html_url}); pick that repository's work separately.`);
    }
    const part: LegacyChild = { number: child.number, title: child.title, url: child.html_url, text: child.body ?? '', kind: labelKind(labels), labels,
      state: 'closed', notPlanned: child.state_reason === 'not_planned' };
    if (labels.includes('build') && !part.notPlanned) {
      const closing = JSON.parse(await run(['issue', 'view', String(child.number), '-R', repo, '--json', 'closedByPullRequestsReferences'])) as {
        closedByPullRequestsReferences: { url: string }[];
      };
      if (closing.closedByPullRequestsReferences.length === 1) {
        const url = closing.closedByPullRequestsReferences[0]!.url;
        const pr = JSON.parse(await run(['pr', 'view', url, '--json', 'state,url'])) as { state: string; url: string };
        if (pr.state === 'MERGED') {
          const matched = pr.url.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)$/);
          if (matched) part.mergedPr = `${matched[1]}#${matched[2]}`;
        }
      }
    }
    children.push(part);
  }
  return children;
}

/** An issue's state and assignees as a work record observes them; not-found when `repo` has no issue `number`. */
export async function observeIssue(repo: string, number: number, run: (args: string[]) => Promise<string> = gh): Promise<TicketObservation> {
  let issue: { state: string; assignees: { login: string }[] };
  try {
    issue = JSON.parse(await run(['issue', 'view', String(number), '-R', repo, '--json', 'state,assignees']));
  } catch (err) {
    if (/Could not resolve to an issue/.test(message(err))) return { state: 'not-found' };
    throw refusalOf(err);
  }
  const assignee = issue.assignees.map((a) => a.login).sort().join(', ');
  return { state: issue.state === 'OPEN' ? 'open' : 'closed', ...assignee && { assignee } };
}
