import { createPublication } from './publication/publication.ts';
import { publicationVocabulary } from './publication/vocabulary.ts';
import { repositoryProjects, reauthorizeRepositoryProjects } from './t3/repository-project-discovery.ts';
// The board server: reads each item source through `gh` or `az` at its own pace, every 15 s while it holds active work
// and every 5 min while idle, refreshes T3's threads and stats every 2 s without either, keeps the last good copy in
// memory, serves it on 127.0.0.1 and pushes each change to open pages over /api/events.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { GH_FLOOR, SETTLED_FIRST_READ, SLOW_CHECKS_MS, ghBlocksRead, itemSource, onAzure, providerTool, refKey, sameRepo, usesGh, type BoardData, type FirstRead, type Item, type ItemSource, type ModelGroup, type ProviderTool, type Status, type ToolChecks, type ToolProgress } from '@lar-factory/shared';
import { boardDataDir } from '@lar-factory/shared/data-dir';
import { openWorkRecords, type WorkRecords } from '@lar-factory/work-records';
import { createBoardState } from './board/board-state.ts';
import { configUpdateOf, dismissConfigUpdate } from './config/config-update.ts';
import { openConfigUpdatePr, readEditPrs } from './config/edit-config.ts';
import { onTheBoard, readBoardSettings, readRepositoryList, stillOnboarding, type OnboardedRepository } from './config/repository-config.ts';
import { observePr } from './config/pr-host.ts';
import { changeRepositorySettings, readDismissedUpdates, readOnboardedConfigs } from './config/repository-settings.ts';
import { editPrBody, ghCooldown, ghQuotaLow, observeIssue, readPrBody } from './github/github.ts';
import { mergedStats, prStatsEdits, retainStats, updatedBody } from './github/pr-stats.ts';
import { createBoardServer } from './http/http.ts';
import { createCapture } from './items/capture.ts';
import { createItemCommands } from './items/item-commands.ts';
import { ACTIVE_READ_MS, onboardedSources, repoView } from './items/item-sources.ts';
import { finishCompleted, observeRecords } from './items/observe-records.ts';
import { createRetention } from './items/retention.ts';
import { archivedItems, recordItems, ticketsByReference } from './items/record-items.ts';
import type { ItemsRead, ReadPace, ReadProgress, TicketObservation } from './items/item-source.ts';
import { log } from './log.ts';
import { createItemDetails, detailsFileFor } from './item-details/item-details.ts';
import { createConfigChecks } from './onboarding/config-checks.ts';
import { createProject } from './onboarding/create-project.ts';
import { keepOnboarding } from './onboarding/keep-onboarding.ts';
import { createPrOpener, previewOnboardingPr } from './onboarding/onboarding-pr.ts';
import { onboardingOffers, projectChoices } from './onboarding/project-choices.ts';
import { detectSetup } from './onboarding/detect-setup.ts';
import { importTickets, importableTickets } from './onboarding/import-tickets.ts';
import { saveSetup } from './onboarding/save-setup.ts';
import { loadBuild } from './page/page.ts';
import { recordBoard } from './port/board-record.ts';
import { BOARD_PORTS, listenOnFreePort, reportListening } from './port/port.ts';
import { installHome, loadBundledSkills, withInstallState } from './skills/bundled-skills.ts';
import { parentSkillCheck } from './skills/skill-check.ts';
import { createStartAfter } from './start-after/start-after.ts';
import type { StatsSources } from './stats/item-stats.ts';
import { loadModelChoices } from './t3/model-choices.ts';
import { anyOnAzureDevOps, repositoryProjectHints } from './t3/repository-project.ts';
import { protocolItemThreads } from './t3/item-execution.ts';
import { loadT3Reads, warmT3Stats } from './t3/t3-reads.ts';
import { environmentIdPath, modelManifestPath, readEnvironmentId, statsDbPath, t3SettingsPath, usageRatesPath } from './t3/t3-settings.ts';
import { TOOL_NAMES, checkTools, lookUpTools, missingTool, probeGh, tools } from './tools/tools.ts';

const HOST = '127.0.0.1';
const settings = readBoardSettings();
// A settings file the board can't use leaves it on the defaults; the problem stays the board's read error until it restarts.
if (settings.problem) log(`using the default settings: ${settings.problem}`);
const fixture = process.env.BOARD_DATA_FILE;
const capture = { session: randomUUID(), enabled: !fixture };
const bundled = loadBundledSkills();
if (bundled.error) log(`no bundled skills in Settings: ${bundled.error}`);
/** The bundled skills with their install state; the Sample board shows none, as it installs nothing. */
const bundledSkills = () => fixture ? bundled.skills : withInstallState(bundled.skills, installHome());

const board = createBoardState({
  capture,
  repos: [],
  refreshSeconds: settings.refreshSeconds,
  fetchedAt: null,
  error: settings.problem ?? null,
  items: [],
  firstRead: { step: 'repositories', running: [], settled: false },
  modelChoices: [],
  bundledSkills: bundledSkills(),
});

/**
 * The work records the board shows and moves, which threads change through lar-work too; null in sample mode and when
 * the database can't be opened, which `recordsProblem` names as the board's error until it restarts.
 */
let records: WorkRecords | null = null;
let recordsProblem: string | null = null;
if (!fixture) {
  try { records = await openWorkRecords(); }
  catch (err) {
    recordsProblem = `Can't open the work records: ${(err as Error).message}`;
    log(recordsProblem);
    board.update({ error: settings.problem ?? recordsProblem });
  }
}
/** This Mac's retention setting, which hides finished and set-aside work in Archive and runs the timed delete Settings chose. */
// A saved change shows at once; `reread` is defined below, before any request arrives.
const retention = createRetention({ records, changed: () => reread() });
/** The tickets the item sources read last, which give the records their ticket context. */
let tickets: Item[] = [];
let ticketsByRef = new Map<string, Item>();
/** The repositories whose source that read hadn't read yet, whose records wait for their tickets. */
let unread: string[] = [];
/** The ticket item a board item's record names, as the item sources read it last; undefined for work with no ticket. */
const ticketOf = (item: Item): Item | undefined => (item.number ? ticketsByRef.get(refKey(item.repo, item.number).toLowerCase()) : undefined);
/**
 * The board items: the onboarded repositories' work records, as they are now, with `read`'s tickets, kept for later,
 * less the work in Archive, which `archive` reads when Settings › Archive asks. Work a repository's changed setup
 * affects waits, as the rows' setups say.
 */
function recordedItems(read: Pick<ItemsRead, 'items' | 'waiting'> = { items: tickets, waiting: unread }): Item[] {
  if (read.items !== tickets) ticketsByRef = ticketsByReference(read.items);
  tickets = read.items;
  unread = read.waiting ?? [];
  if (!records) return [];
  const repos = items.repos().map((r) => r.repo);
  const hidden = retention.hidden();
  board.update({ retention: retention.state() });
  const setups = board.snapshot().repos.flatMap((r) => r.setup ? [r.setup] : []);
  return recordItems(records, tickets, repos, unread, hidden, setups);
}

/** Archive's work as the records are now, with the last tickets read: set aside, or finished and hidden by retention. */
const archive = (): Item[] => records ? archivedItems(records, tickets, items.repos().map((r) => r.repo), retention.hidden()) : [];

const statsSources: StatsSources = { db: statsDbPath(), settings: t3SettingsPath(), rates: usageRatesPath(), home: homedir() };
const modelManifest = modelManifestPath();
const environmentIdFile = environmentIdPath();
// Each read publishes the repositories once their configs load, so Add item offers them while the items still load.
const items = onboardedSources(async () => {
  let list: OnboardedRepository[];
  try { list = readRepositoryList(); }
  catch (err) {
    // A list the board can't read onboards nothing, so no repository or notice of the last good read stays beside its error.
    board.update({ repos: [], repositoryConfigProblems: [], onboarding: [] });
    throw err;
  }
  // A repository still onboarding has no local settings until it saves them, so it stays off the board. Each refresh
  // asks gh for every open Edit PR, so its row's mark survives a restart and goes once the PR merges or closes. A file below the app's Repository config
  // version gets the notice offering its update PR, unless this Mac dismissed it at that version.
  const onboarded = onTheBoard(list);
  const [read, editPrs] = await Promise.all([readOnboardedConfigs(list),
    readEditPrs(onboarded.map((e) => e.repo), undefined, (repo, problem) => log(`can't read ${repo}'s Edit PR: ${problem}`))]);
  const dismissed = readDismissedUpdates();
  board.update({
    repos: read.configs.map((config, index) => {
      const configUpdate = configUpdateOf(config, dismissed);
      return { ...repoView(config), version: config.version, ...editPrs.has(config.repo) && { editPr: editPrs.get(config.repo) },
        ...configUpdate !== undefined && { configUpdate }, setup: read.setups[index]! };
    }),
    repositoryConfigProblems: read.problems, onboarding: stillOnboarding(list),
  });
  moveFirstRead({ step: 'items' });
  return read;
});
/** Each repository's .lar-factory.json answer for onboarding, kept until Recheck. */
const configChecks = createConfigChecks();
/** T3's projects as onboarding offers them, as the list is now. */
const choices = () => projectChoices(onboarded(), configChecks.configOf);
const offersUnavailable = flipLog("no onboarding offers: can't read T3 Code's projects", 'onboarding offers readable again');
let refreshing = false;
/** Set when a read is asked for during a running one, so exactly one more starts after it. */
let readAgain = false;
let syncingPrStats = false;
/** When the board last wrote each PR's stats block, by PR URL. */
const prStatsSyncedAt = new Map<string, number>();
const PR_STATS_MS = 5 * 60_000;
/** The running tool check, so Recheck and the retry never run two at once. */
let checkingTools: Promise<void> | null = null;
/**
 * The startup check of gh, while an onboarded repository needs it, which runs once the board listens; requests other
 * than /healthz and assets wait for it, as a gh that blocks the read has its notice. They wait for no other check: an
 * Azure DevOps source names its own az problems, and the other tools' notices show as their checks land.
 */
let firstGhCheck: Promise<void> | undefined;
/** Whether the first tool lookup is done, which the first read waits for, as every source runs a tool it found. */
let lookedUp = false;
/** The providers' tools being checked with no result yet, whose sources wait for them, as the first read does. */
const unchecked = new Set<ProviderTool>();
/** Every command a check may run. */
const CHECKED_TOOLS = ['gh', 't3', 'git', 'jq', 'curl', 'az'] as const;

/** Shows the check's progress, keeping what `progress` leaves out. */
function showToolProgress(progress: Partial<ToolProgress>): void {
  const before = board.snapshot().toolProgress ?? { checking: [], skipped: [] };
  board.update({ toolProgress: { ...before, ...progress } });
  board.push();
}
let toolRetry: NodeJS.Timeout | undefined;
let toolLog = '';
/** How often the board looks again while a check fails that retriesTools names. Tests shorten it with BOARD_TOOL_RETRY_MS. */
const TOOL_RETRY_MS = Number(process.env.BOARD_TOOL_RETRY_MS) || 10_000;

/**
 * Changes the first read's progress and pushes it at once, so a page names what runs now. A settled first read stays
 * settled: the polls and reads after it report nothing.
 */
function moveFirstRead(change: Partial<FirstRead>): void {
  const current = board.snapshot().firstRead;
  if (current.settled) return;
  board.update({ firstRead: { ...current, ...change } });
  board.push();
}

/** Marks each item source of the first read as running while it reads. */
const firstReadProgress: ReadProgress = {
  started: (name) => moveFirstRead({ running: [...board.snapshot().firstRead.running, name] }),
  finished: (name) => {
    const running = [...board.snapshot().firstRead.running];
    const at = running.indexOf(name);
    if (at !== -1) running.splice(at, 1);
    moveFirstRead({ running });
  },
};

/** Whether T3's transcripts are being read, or were, for the stats. */
let warming = false;
/**
 * The first read ends: it read the repositories, failed, or the provider's tool blocked it. Then the board reads T3's
 * transcripts for the stats, which would slow the first read, as their parsing shares its thread, and shows and writes
 * them.
 */
const settleFirstRead = () => {
  moveFirstRead({ running: [], waiting: undefined, settled: true });
  if (warming || fixture) return;
  warming = true;
  void warmT3Stats(statsSources).finally(() => {
    transcriptsRead = true;
    refreshLocal();
    // The first read had no fresh stats to write to the builds' open PRs; they have now.
    void syncPrStats(board.snapshot().items);
  });
};

/** Whether gh's check blocks sources of `kind`. A gh that wasn't checked, as no listed repository was on GitHub, blocks nothing. */
function blockedByTool(kind: ItemSource): boolean {
  const gh = board.snapshot().tools?.gh;
  return gh !== undefined && ghBlocksRead(gh, kind);
}

/** Whether sources of `kind` wait for their provider's tool: while its first check runs, or while it blocks them. */
const waitsForTool = (kind: ItemSource) => unchecked.has(providerTool(kind)) || blockedByTool(kind);

/** Logs `whenSet` or `whenCleared` each time the condition it's given flips; it starts cleared. */
function flipLog(whenSet: string, whenCleared: string): (set: boolean) => void {
  let last = false;
  return (set) => {
    if (set !== last) log(set ? whenSet : whenCleared);
    last = set;
  };
}

const statsUnavailable = flipLog(`item stats unavailable: can't read ${statsSources.db}`, `item stats readable again from ${statsSources.db}`);
const pricingUnavailable = flipLog(`API cost unavailable: can't read rates from ${statsSources.rates}`, `API cost readable again from ${statsSources.rates}`);
const modelsUnavailable = flipLog(`only T3 default offered: no models read from ${statsSources.settings} and ${modelManifest}`, 'model choices readable again');

/**
 * Whether T3's transcripts were read once since the board started. A cold read of every transcript takes about 12 s,
 * so warmT3Stats reads them without blocking once the first read settles, and the board shows without waiting for it.
 */
let transcriptsRead = false;

/**
 * Attaches each item's stats and T3 threads, from one read of T3 Code's database. Stats are those frozen in its
 * latest merged linked PR's block once no linked PR is open, else read afresh from the database and transcripts once
 * those were read; the threads its work record holds are read afresh. The board keeps working without either.
 */
function withT3Reads(items: Item[], withStats = true): Item[] {
  const now = Date.now();
  const fresh = withStats && transcriptsRead;
  const threadIds = (workId: string | undefined) => (workId && records ? records.threads(workId).map((t) => t.threadId) : []);
  const threads = (workId: string | undefined) => protocolItemThreads(threadIds(workId));
  const { stats, statsUnavailable: unreadable, priced } = loadT3Reads(statsSources, now, fresh);
  if (fresh) {
    statsReadAt = now;
    statsUnavailable(unreadable);
    if (priced !== null) pricingUnavailable(!priced);
  }
  const previousStats = new Map(board.snapshot().items.map((item) => [item.id, item.stats]));
  return items.map((item) => {
    const known = retainStats(previousStats.get(item.id), item.stats);
    const live = fresh ? stats(threadIds(item.id)) : item.stats;
    const shown = { ...item, stats: withStats ? mergedStats({ ...item, stats: known }, live) ?? retainStats(known, live) : known, threads: threads(item.id) };
    // A slice records its implementer thread, so a build is running while a thread runs for it or any slice.
    const running = (found: ReturnType<typeof threads>) => Array.isArray(found) && found.some((t) => t.state === 'running');
    if (running(shown.threads) || item.slices.some((slice) => running(threads(slice.workId)))) lastRunning.set(item.id, now);
    return shown;
  });
}

/** Tests read every source this often, whatever its work; unset, sources read at their pace. */
const TEST_READ_MS = Number(process.env.BOARD_READ_MS) || 0;
/** How often the board reads T3's database for threads, and for stats, which cost several times more; neither calls gh or az. */
const LOCAL_REFRESH_MS = 2_000;
const LOCAL_STATS_MS = 30_000;
let statsReadAt = -Infinity;
/** How long an item stays active after its thread stops running or it closes, so a source reads what the agent wrote last. */
const SETTLE_MS = 5 * 60_000;
/** The statuses an agent works in, which keep an item active while T3 can't say whether its thread runs. */
const AGENT_STATUSES = new Set<Status>(['Shaping', 'In progress', 'Review']);
/** When each item last had a running thread of its own or of one of its slices, by Item.id. */
const lastRunning = new Map<string, number>();

/**
 * Whether an item keeps its source on the fast cadence: its thread runs or ran in the last SETTLE_MS, it sits in an
 * agent's status while T3 can't say, it closed in the last SETTLE_MS, its PR's checks run, the board shows a change to
 * it GitHub hasn't reported, or an armed start waits on it or for it.
 */
function isActive(ticket: Item, now: number, waitedOn: ReadonlySet<string>, shownFor: ReadonlyMap<Item, Item>): boolean {
  // A source paces its tickets; the board knows each by its record's work ID.
  const item = shownFor.get(ticket) ?? ticket;
  if (now - (lastRunning.get(item.id) ?? -Infinity) < SETTLE_MS) return true;
  if (item.state === 'open' && AGENT_STATUSES.has(item.status) && board.snapshot().tools?.t3?.result !== 'ok') return true;
  if (item.closedAt && now - Date.parse(item.closedAt) < SETTLE_MS) return true;
  if (checksRunning(item, now)) return true;
  if (board.changing(item.id) || board.snapshot().armed?.[item.id]) return true;
  return waitedOn.has(refKey(item.repo, item.number));
}

/** When the board first saw each PR's checks running, by its URL, for checks GitHub gives no start time. */
const checksSeenAt = new Map<string, number>();

/** Whether the item's PR's checks run, short of SLOW_CHECKS_MS: a check stuck past it, as an EXPECTED one that never reports, stops polling. */
const checksRunning = (item: Item, now: number) => item.linkedPrs.map((pr) => [pr.url, pr] as const)
  .some(([key, pr]) => {
    if (!pr?.checks?.running) return void checksSeenAt.delete(key);
    if (!checksSeenAt.has(key)) checksSeenAt.set(key, now);
    return now - (pr.checks.since ? Date.parse(pr.checks.since) : checksSeenAt.get(key)!) < SLOW_CHECKS_MS;
  });

/** The idle pace: the list file's refreshSeconds, at least a minute, so a setting saved from before ADR 0028 spends no more. */
const idleMs = () => TEST_READ_MS || Math.max(60, settings.refreshSeconds) * 1000;

/** The pace reads run at now: slow while gh's quota runs low. */
function readPace(): ReadPace {
  const now = Date.now();
  const armed = board.snapshot().armed ?? {};
  const waitedOn = new Set(board.snapshot().items.filter((i) => armed[i.id]).flatMap((i) => i.blockers.map((b) => refKey(b.repo, b.number))));
  // The board item showing each ticket, built once a pace as a source asks about each of its tickets.
  const shownFor = new Map<Item, Item>();
  for (const shown of board.snapshot().items) {
    const ticket = ticketOf(shown);
    if (ticket && !shownFor.has(ticket)) shownFor.set(ticket, shown);
  }
  return { now, slow: quotaLow, activeMs: TEST_READ_MS || ACTIVE_READ_MS, idleMs: idleMs(),
    active: (item) => isActive(item, now, waitedOn, shownFor), polled: (item) => checksRunning(item, now), waits: waitsForTool, blocked: blockedByTool };
}

/** Whether gh's quota ran low at its last check, made at most every QUOTA_CHECK_MS. */
let quotaLow = false;
let quotaCheckedAt = -Infinity;
const QUOTA_CHECK_MS = 5 * 60_000;
async function checkQuota(): Promise<void> {
  if (Date.now() - quotaCheckedAt < QUOTA_CHECK_MS) return;
  quotaCheckedAt = Date.now();
  const low = await ghQuotaLow().catch(() => quotaLow);
  if (low !== quotaLow) log(low ? "gh's quota is low: every source reads at the idle pace" : "gh's quota recovered");
  quotaLow = low;
}

/**
 * Shows the work records as they are now, which threads may have changed, with T3's threads and every LOCAL_STATS_MS
 * its stats, pushing only when they changed, and starts the armed parts a record's change unblocked. Before the first
 * read lands, there are no records to show yet. `recordsChanged` publishes the board's own observation writes,
 * already copied into its snapshot, even while a provider read runs.
 */
function refreshLocal(recordsChanged = false): void {
  if (refreshing && !recordsChanged) return;
  void t3Availability().then(source => {
    board.update({ t3Availability: source });
    board.push();
  });
  const before = board.snapshot().items;
  if (board.snapshot().fetchedAt !== null || before.length) showRecords(Date.now() - statsReadAt >= LOCAL_STATS_MS);
  let after = board.snapshot().items;
  const running = (item: Item) => Array.isArray(item.threads) && item.threads.some((t) => t.state === 'running');
  // A run can finish between stats reads. Read its final turn before writing the settled PR block.
  const finished = after.some((item) => running(before.find((b) => b.id === item.id) ?? item) && !running(item));
  if (finished) board.update({ items: after = withT3Reads(after) });
  void commands.reconcileStarts(after);
  if (!recordsChanged && JSON.stringify(after) === JSON.stringify(before)) return;
  board.push();
  void syncPrStats(after);
  // A blocker completes from local facts, as a decision's answer the shaping session records, without any ticket read.
  void startAfter.startUnblocked();
}

/** Shows the work records as they are now with the last tickets read, and their T3 threads; stats only when `withStats`. */
function showRecords(withStats = false): void {
  board.applyRead(recordedItems(), board.revision(), (shown) => withT3Reads(shown, withStats));
}

/**
 * Brings the stats block in each open PR linked to a build up to date;
 * a failed edit is logged and tried again next refresh. Runs beside the refreshes,
 * never two at once: a refresh while one runs starts none.
 */
async function syncPrStats(items: Item[]): Promise<void> {
  if (syncingPrStats || !transcriptsRead) return;
  syncingPrStats = true;
  try {
    const now = Date.now();
    for (const edit of prStatsEdits(items)) {
      // Stats grow while a build runs; each PR's block is written at most every PR_STATS_MS, not on every read.
      if (!edit.final && now - (prStatsSyncedAt.get(edit.url) ?? -Infinity) < PR_STATS_MS) continue;
      prStatsSyncedAt.set(edit.url, now);
      try {
        // The board read the body a while ago; apply the block to the body as it is now, so no one's edit is lost.
        const body = updatedBody(await readPrBody(edit.url), edit.block);
        if (body === null) continue;
        await editPrBody(edit.url, body);
        log(`updated item stats in ${edit.url}`);
      } catch (err) {
        log(`could not update item stats in ${edit.url}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } finally {
    syncingPrStats = false;
  }
}

/** Reads the model choices T3 offers now into the board data. */
function offerModelChoices(): ModelGroup[] {
  const groups = loadModelChoices(statsSources.settings, modelManifest);
  modelsUnavailable(!groups.length);
  board.update({ modelChoices: groups });
  return groups;
}

/** Logs where each tool is, or why it's missing, when that changes. */
function logTools(): void {
  const lines = TOOL_NAMES.map((name) => {
    const path = tools()?.[name].path;
    return path ? `${name} at ${path}` : missingTool(name);
  });
  const checks = board.snapshot().tools;
  const gh = checks?.gh;
  if (gh?.result === 'logged-out') lines.push('gh is logged out');
  if (gh?.result === 'outdated') lines.push(`gh is older than ${GH_FLOOR}`);
  if (checks?.t3?.result === 'not-running') lines.push('T3 Code is not running');
  const az = checks?.az?.result;
  if (az === 'logged-out') lines.push('az is logged out');
  if (az === 'no-extension') lines.push('az has no azure-devops extension');
  const message = lines.join('; ');
  if (message !== toolLog) log(message);
  toolLog = message;
}

/**
 * Whether the board looks again by itself: while gh is missing or logged out, which stops
 * reads, while t3 is missing or T3 Code isn't running, once its check landed. An old gh, a missing git, jq or curl and az wait for Recheck.
 */
function retriesTools(checks: ToolChecks): boolean {
  return ['missing', 'logged-out'].includes(checks.gh?.result ?? 'ok') || checks.t3 !== undefined && checks.t3.result !== 'ok';
}

/** Shows the checks, whose failures have notices, and looks again in TOOL_RETRY_MS while retriesTools says so. */
function showToolChecks(checks: ToolChecks): void {
  board.update({ tools: checks });
  logTools();
  clearTimeout(toolRetry);
  if (retriesTools(checks)) toolRetry = setTimeout(() => void recheckTools(false), TOOL_RETRY_MS);
}

/**
 * Looks every tool up again and checks each command, gh only while a listed repository is on GitHub or `asked.gh` asks
 * for it, and az only while one is on Azure DevOps or `asked.az` asks for it. Each check shows as it lands, and a
 * provider's tool checked for the first time reads its sources then; `ghChecked` hears when gh's check landed or none runs.
 * Reads every source again if gh no longer stops the read. Startup and Recheck reread the login shell PATH; the timed
 * retry passes false to keep the last one. A check asked for during a running one waits for it, then runs.
 */
async function recheckTools(rereadLoginPath = true, asked: { gh?: boolean; az?: boolean } = {}, ghChecked = () => {}): Promise<void> {
  while (checkingTools) await checkingTools;
  // Recheck asks each repository for its .lar-factory.json again; the timed retry keeps the answers.
  if (rereadLoginPath) configChecks.clear();
  const { tools: before } = board.snapshot();
  const ghBlocked = before !== undefined && ghStopsRead(before);
  checkingTools = (async () => {
    // Until the lookup tells which providers' tools are needed, every command counts as checking.
    showToolProgress({ checking: [...CHECKED_TOOLS] });
    const listed = onboarded();
    const [, withAz] = await Promise.all([lookUpTools(process.env, rereadLoginPath), anyOnAzureDevOps(listed)]);
    lookedUp = true;
    const needs = { gh: usesGh(listed) || asked.gh === true, az: withAz || asked.az === true };
    // A check run before keeps its sources reading until the new one lands.
    for (const tool of ['gh', 'az'] as const) if (needs[tool] && !before?.[tool]) unchecked.add(tool);
    if (!unchecked.has('gh')) ghChecked();
    showToolProgress({ checking: CHECKED_TOOLS.filter((tool) => tool !== 'gh' && tool !== 'az' || needs[tool]),
      skipped: (['gh', 'az'] as const).filter((tool) => !needs[tool]) });
    readNow();
    const { tools: checks, ghError } = await checkTools(needs, undefined, (check) => {
      board.update({ tools: { ...board.snapshot().tools, ...check } });
      showToolProgress({ checking: (board.snapshot().toolProgress?.checking ?? []).filter((tool) => !(tool in check)) });
      const provider = (['gh', 'az'] as const).find((tool) => tool in check && unchecked.delete(tool));
      if (!provider) return;
      if (provider === 'gh') ghChecked();
      readNow();
    });
    showToolChecks(checks);
    if (ghError) log(`gh probe failed: ${ghError}`);
  })().finally(() => {
    checkingTools = null;
    showToolProgress({ checking: [] });
    // A check that failed before its providers' tools landed lets their sources read now, not at the next tick.
    if (unchecked.size) {
      unchecked.clear();
      readNow();
    }
    ghChecked();
  });
  await checkingTools;
  board.push();
  if (ghBlocked && !ghStopsRead(board.snapshot().tools)) readSoon();
}

/** The onboarded repositories as the list is now; none while it can't be read, which the read reports. */
function onboarded(): OnboardedRepository[] {
  try { return readRepositoryList(); }
  catch { return []; }
}

/**
 * Whether the checks in `checks` stop the read: before the first check, or when gh's check blocks every repository the
 * board lists. With none, only a missing or logged-out gh stops it. A gh that wasn't
 * checked, as no listed repository was on GitHub, stops nothing.
 */
function ghStopsRead(checks: ToolChecks | undefined): boolean {
  if (!checks) return true;
  const check = checks.gh;
  if (!check) return false;
  const repos = items.repos();
  const sources: ItemSource[] = repos.length ? repos.map(itemSource) : ['issues'];
  return sources.every((source) => ghBlocksRead(check, source));
}

/**
 * Reads the sources due at the pace now; while a read runs this one is skipped, so two reads never run together, and
 * a tick with no source due reads nothing.
 */
async function refresh(): Promise<void> {
  if (refreshing) return;
  // Every source reads with a tool the first lookup finds; each waits for its own provider's check through the pace.
  if (!lookedUp) return;
  refreshing = true;
  readAgain = false;
  let read = false;
  const readRevision = board.revision();
  try {
    await checkQuota();
    const pace = readPace();
    await items.probe(pace);
    if (!items.due(pace)) return;
    offerModelChoices();
    // The app installs after the board server starts, so each read picks up the latest install's state.
    board.update({ bundledSkills: bundledSkills() });
    const { error, fetchedAt } = board.snapshot();
    // During the first read, each source's read shows its repositories' items as it lands, though another still reads.
    const landed = (partial: ItemsRead) => {
      if (board.snapshot().firstRead.settled) return;
      // A read so far confirms no change the board made, as the source of one may not have read yet, and isn't the
      // whole read fetchedAt times.
      board.applyRead(recordedItems(partial), readRevision, withT3Reads, () => false);
      board.update({ itemSourceProblems: partial.problems ?? [] });
      moveFirstRead({ waiting: partial.waiting });
    };
    const snapshot = await items.read({ ...firstReadProgress, landed }, pace);
    const repos = items.repos();
    // Before the first whole read, every source waited for its tool's check or was blocked by it, so nothing read: the
    // board keeps showing no read, as before it. After one, a source its tool blocks keeps its last read, which stays fresh.
    if (fetchedAt === null && repos.length > 0 && repos.every((repo) => snapshot.waiting?.includes(repo.repo) || blockedByTool(itemSource(repo)))) return;
    const recovered = error !== null && error !== (settings.problem ?? recordsProblem) || fetchedAt === null;
    board.applyRead(recordedItems(snapshot), readRevision, withT3Reads, items.readAfresh);
    moveFirstRead({ step: 'finishing', waiting: snapshot.waiting });
    board.update({ fetchedAt: new Date().toISOString(), error: settings.problem ?? recordsProblem, itemSourceProblems: snapshot.problems ?? [],
      t3Availability: await t3Availability(), t3EnvironmentId: readEnvironmentId(environmentIdFile), repositoryProjects: await repositoryProjectHints(repos) });
    if (recovered) log(`read ${snapshot.items.length} items from ${repos.length} repositories`);
    read = true;
  } catch (err) {
    // While a listed repository is on GitHub, probe gh, so a gh that went missing or logged out shows its notice instead
    // of Stale; a cooling gh calls nothing. An Azure DevOps source names its own az problems.
    const checks = board.snapshot().tools ?? {};
    const ghInUse = usesGh(items.repos());
    const gh = !ghInUse || ghCooldown.until() ? { check: checks.gh } : await probeGh();
    if (gh.check && gh.check.result !== 'ok') showToolChecks({ ...checks, gh: gh.check });
    const ghError = 'error' in gh ? gh.error : undefined;
    const error = ghStopsRead({ ...checks, ...gh.check && { gh: gh.check } }) ? null : ghError ?? (err instanceof Error ? err.message : String(err));
    board.update({ error });
    if (error) log(`refresh failed, serving data from ${board.snapshot().fetchedAt ?? 'never'}: ${error}`);
  } finally {
    refreshing = false;
    // A source still waiting for its provider's first check reads once it lands, which asks for the read that settles
    // the first read then.
    if (!readAgain && !items.repos().some((repo) => unchecked.has(providerTool(itemSource(repo))))) settleFirstRead();
    // A read asked for during this one starts once this one ends, though it read nothing.
    if (readAgain) queueMicrotask(() => void refresh());
  }
  board.push();
  // Repositories not answered yet take a gh call each, so the offers follow the read instead of holding it up, at the idle
  // pace or after a read request naming no item, not after each read of active work.
  if (read && (offersAsked || Date.now() - offeredAt >= idleMs())) {
    offersAsked = false;
    offeredAt = Date.now();
    void offerOnboarding().then(() => board.push());
  }
  // PR edits take a gh call or two each, and a start runs t3; the board doesn't wait for them.
  if (read) void syncPrStats(board.snapshot().items);
  if (read) void startAfter.startUnblocked();
  if (read) void observeProviders();
}

/**
 * The ticket as the item sources' last read showed it, when that read shows it open with its assignees; undefined when
 * it doesn't, as for a closed ticket, which takes a read of its own.
 */
function knownTicket(repo: string, number: number): TicketObservation | undefined {
  const ticket = ticketsByRef.get(refKey(repo, number).toLowerCase());
  const assignee = ticket?.azure ? ticket.azure.assignee : ticket?.assignee;
  if (ticket?.state !== 'open' || assignee === undefined) return undefined;
  return { state: 'open', ...assignee && { assignee } };
}

/** When the records' tickets and PRs were last observed, which runs at the idle pace as each record takes a call or two. */
let observedAt = -Infinity;
let observing = false;

/**
 * Records what each onboarded repository's tickets and PRs show now, then finishes the decisions and concepts now
 * complete; the next local refresh shows what changed.
 */
async function observeProviders(): Promise<void> {
  if (!records || observing || Date.now() - observedAt < idleMs()) return;
  observing = true;
  observedAt = Date.now();
  const repos = items.repos().map((r) => r.repo);
  try {
    // While gh's quota runs low, GitHub repositories' reads wait and their records and Dependencies keep their last
    // observation; az reads go on. A GitHub ticket reads through gh whether or not its repository is onboarded, as a
    // Dependency's owner may not be.
    await observeRecords(records, quotaLow ? repos.filter(onAzure) : repos, {
      ticket: (repo, number) => (onAzure(repo) ? items.observeTicket(repo, number) : observeIssue(repo, number)),
      pr: (repo, number) => observePr(repo, number),
      known: (repo, number) => knownTicket(repo, number),
      waits: (repo) => quotaLow && !onAzure(repo),
    }, retention.hidden(), showRecords);
    // After the PR reads, so a concept whose last build merged finishes in the same pass.
    finishCompleted(records, repos);
    // The timed delete, once Settings turned it on, runs at the same idle pace.
    retention.deleteDue();
  } finally {
    observing = false;
  }
  refreshLocal(true);
}

let offeredAt = -Infinity;
let offersAsked = false;

/** Offers to onboard each T3 project whose repository has .lar-factory.json and isn't on the list; none while T3's projects can't be read. */
async function offerOnboarding(): Promise<void> {
  try {
    board.update({ onboardingOffers: onboardingOffers(await choices()) });
    offersUnavailable(false);
  } catch {
    board.update({ onboardingOffers: [] });
    offersUnavailable(true);
  }
}

/**
 * Reads the source listing the item at `url` now, or every source after loading the configs again when there is none;
 * or once more after the running read, so a change made during that read is read too.
 */
function readSoon(url?: string): void {
  if (url === undefined) {
    items.reload();
    offersAsked = true;
  } else items.invalidate(url);
  readNow();
}

/** Reads the sources due now, or once more after the running read. */
function readNow(): void {
  if (refreshing) readAgain = true;
  else void refresh();
}

// The page `pnpm run build` wrote, read once at startup. The path is relative to this
// entry, so it holds both for the source and for the packaged app's bundle in
// Resources/server/dist/, beside Resources/web/dist/.
const page = loadBuild(new URL('../../web/dist/', import.meta.url));

const reread = () => {
  showRecords();
  board.push();
};
const commands = createItemCommands({ board, items, records, reread, archive, offerModelChoices, checkSkills: parentSkillCheck() });
const adding = createCapture({ board, items, records, reread, repos: items.repos });
// Sample mode keeps no armed starts: it serves a fixed file and starts nothing.
const startAfter = createStartAfter({ board, commands, offerModelChoices, file: fixture ? null : join(boardDataDir(), 'armed-starts.json') });
const { server, endStreams } = createBoardServer({
  board, commands, capture: adding, startAfter, retention, archive, page, appSecret: process.env.BOARD_APP_SECRET || null, sample: !!fixture,
  reauthorizeT3: async () => {
    const read = await reauthorizeRepositoryProjects();
    board.update({ t3Availability: { availability: read.availability, observedAt: read.observation?.observedAt } });
    if (read.availability !== 'available') throw new Error('T3 unavailable');
  },
  recheck: (options) => recheckTools(true, options), itemDetails: createItemDetails(fixture ? detailsFileFor(fixture) : null, ticketOf, { records }), readSoon, ready: () => firstGhCheck, projectChoices: choices,
  keepOnboarding: (input) => keepOnboarding(input),
  createProject: (input) => createProject(input, choices),
  detectSetup: (input) => detectSetup(input), saveSetup: (input) => saveSetup(input),
  importableTickets: (input) => importableTickets(input, records),
  importTickets: async (input) => {
    const imported = await importTickets(input, records);
    if ('imported' in imported) reread();
    return imported;
  },
  openOnboardingPr: createPrOpener(), previewOnboardingPr: (input) => previewOnboardingPr(input),
  openConfigUpdatePr: (input) => openConfigUpdatePr(input), dismissConfigUpdate: (repo) => dismissConfigUpdate(repo),
  publicationVocabulary,
  publication: createPublication(records, { allowed: (repo) => items.repos().some((row) => sameRepo(row.repo, repo)), changed: reread,
    settings: async (repo) => {
      const result = await publicationVocabulary(repo);
      if ('error' in result) throw new Error(result.error);
      return result;
    },
  }),
  changeRepositorySettings: (input) => changeRepositorySettings(input),
});

/** Logs why the board can't start and exits. */
async function exitWith(message: string): Promise<never> {
  log(message);
  // Piped output is asynchronous on macOS: let the line out before exiting.
  await new Promise((resolve) => process.stdout.write('', resolve));
  process.exit(1);
}

// BOARD_PORT pins the port; zero lets the OS assign it. Otherwise try the normal board range.
const pinned = process.env.BOARD_PORT;
if (pinned && !(/^\d+$/.test(pinned) && Number(pinned) >= 0 && Number(pinned) <= 65535)) {
  await exitWith(`BOARD_PORT=${pinned} is not a port; choose one from 0 to 65535 or unset it`);
}
const ports = pinned ? [Number(pinned)] : BOARD_PORTS;
const port = await listenOnFreePort(server, HOST, ports) ?? await exitWith(ports.length === 1
  ? `port ${ports[0]} is taken; stop what holds it or choose another BOARD_PORT`
  : `ports ${ports[0]} to ${ports.at(-1)} are all taken; stop a board or set BOARD_PORT`);
log(`board on http://${HOST}:${port}, reading active work every ${ACTIVE_READ_MS / 1000} s and the rest every ${settings.refreshSeconds} s`);
reportListening(port);
// status.sh finds live boards by their records; a sample board isn't one to refresh.
if (!fixture) process.on('exit', recordBoard(port));
// Sample mode runs no tools, so it looks none up. The lookup starts the first read, each source once its tool checks.
if (!fixture) firstGhCheck = new Promise((resolve, reject) => void recheckTools(true, {}, resolve).catch(reject));
// Onboarding progress shows before the first read, which waits for the tool lookup.
if (!fixture) board.update({ onboarding: stillOnboarding(onboarded()) });

// BOARD_DATA_FILE serves a fixed JSON file instead of reading GitHub (for
// trying the layout, e.g. with packages/shared/test/sample.json).
if (fixture) {
  board.update({ ...JSON.parse(readFileSync(fixture, 'utf8')) as BoardData, capture, firstRead: SETTLED_FIRST_READ });
  offerModelChoices();
  log(`serving ${fixture} instead of GitHub`);
}
// Each tick only checks whether a source is due; refresh reads nothing when none is.
const timer = setInterval(() => {
  if (!fixture) void refresh();
}, 1_000);
const localTimer = setInterval(() => {
  if (!fixture) refreshLocal();
}, LOCAL_REFRESH_MS);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    clearInterval(timer);
    clearInterval(localTimer);
    clearTimeout(toolRetry);
    endStreams();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}


async function t3Availability() {
  const read = await repositoryProjects();
  return { availability: read.availability, observedAt: read.observation?.observedAt };
}
