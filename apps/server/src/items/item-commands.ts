// The commands the board's buttons send: queue, back to List, start, start build, abandon, close an
// abandoned item's ticket, restore set-aside work and act on Needs you.
// Every Status move writes the item's work record, naming the revision the board read, and never its ticket. The maps of
// commands in flight are private here, so every rule about which command blocks which lives in this file.

import { join } from 'node:path';
import { userInfo } from 'node:os';
import { randomUUID } from 'node:crypto';
import { WAITS_FOR_ONBOARDING, blockedText, buildBranch, buildMessage, canAbandon, isDriftChoice, isOnboarding, sameRepo, workMessage } from '@lar-factory/shared';
import type { BoardData, DriftChoice, Item, ModelChoice, ModelGroup, SkillCheckOutcome, StartedThread, StartResult, Status } from '@lar-factory/shared';
import { WorkRecordError, type LaunchIntent, type WorkRecords } from '@lar-factory/work-records';
import type { BoardState } from '../board/board-state.ts';
import { prHost, prUrl } from '../config/pr-host.ts';
import { readRepositoryList } from '../config/repository-config.ts';
import { readRepositorySetups } from '../config/repository-settings.ts';
import { installHome } from '../skills/bundled-skills.ts';
import { repositoryProject } from '../t3/repository-project.ts';
import type { RepositoryProject } from '../t3/repository-project.ts';
import { findModelChoice } from '../t3/model-choices.ts';
import { protocolStartedThread } from '../t3/item-execution.ts';
import { findStartedThread, lookupThread, startThread } from '../t3/t3.ts';
import type { ItemSource } from './item-source.ts';

/** A command's answer: the HTTP status and the JSON body. */
export interface Reply {
  status: number;
  body: object;
}

export interface ItemCommands {
  /**
   * Settles each unresolved launch intent through T3, and checks each started or recorded thread missing from an
   * available thread read. A thread's state never moves Status.
   */
  reconcileStarts(items: Item[]): Promise<void>;
  queue(itemId: string): Reply;
  backToList(itemId: string): Reply;
  /**
   * Starts a T3 thread for a Queued item that nothing open blocks, once unless its recorded thread stopped or was
   * deleted. It writes a launch intent on the work record before it asks T3, and settles an unresolved one through T3
   * before starting again.
   */
  start(itemId: string, model: unknown): Promise<Reply>;
  /**
   * Starts a Ready build's thread in a new worktree, or retries a confirmed stopped or deleted one, once nothing open
   * blocks it, as lar-shape's step 5 does after Go: it moves a parent record that isn't a build to In progress first,
   * and snapshots the repository's selected project skills on the record. Launch intents guard it as they guard Start.
   * Drift refuses it with the skills that changed until `drift` carries the User's DriftChoice.
   */
  startBuild(itemId: string, model: unknown, drift?: unknown): Promise<Reply>;
  /**
   * Sets List or Queued work aside on this Mac, or work whose Needs you offers it, and leaves its ticket as it is.
   * closeTicket closes that ticket after its own confirmation.
   */
  abandon(itemId: string): Reply;
  /**
   * Closes the open ticket of set-aside work in Archive: as not planned on GitHub, to Removed on Azure DevOps. A close
   * that succeeded answers a second press without closing again.
   */
  closeTicket(itemId: string): Promise<Reply>;
  /** Brings set-aside work in Archive back to the board in the Status it had, unless retention hides it as finished. */
  restore(itemId: string): Reply;
  /**
   * Acts on work that needs you as `choice` says, then clears its reason: `clear` alone, or one of its offers. Reopening
   * the PR reopens it in its provider, a replacement build moves the work to Ready for Start build, and reopening the
   * work moves it to List. Setting it aside is Abandon.
   */
  resolveNeedsYou(itemId: string, choice: unknown): Promise<Reply>;
  /**
   * Marks a Dependency holding the item met, as the user decided, or clears the mark when `met` is false. `revision` is
   * the Dependency's as the board showed it, so a change since then refuses the write.
   */
  markDependencyMet(itemId: string, dependencyId: unknown, revision: unknown, met: unknown): Reply;
}

export interface ItemCommandsDeps {
  board: BoardState;
  /** Where the commands write changes to tickets. */
  items: ItemSource;
  /** Where the commands write Status moves; null in sample mode, which moves nothing. */
  records: WorkRecords | null;
  /** Shows the work records as they are now, after a write or a refused one. */
  reread(): void;
  /** Archive's work as the records are now: set aside, or finished and hidden by retention. */
  archive(): Item[];
  /** Reads the model choices T3 offers now into the board data. */
  offerModelChoices(): ModelGroup[];
  /**
   * Checks the installed skills against the bundle before Start build, replacing Drift if `drift` says so: resolves
   * with why the build can't start, or null, and the skills with Drift while it waits for a choice. Missing without a
   * bundle, so Start build checks nothing.
   */
  checkSkills?: (drift?: DriftChoice) => Promise<SkillCheckOutcome>;
  /** The repository's T3 project as the onboarded repositories are now; tests stand in for it. */
  projectOf?: (repo: string) => Promise<RepositoryProject>;
  /** Starts a T3 thread; tests stand in for t3. */
  startThread?: typeof startThread;
  showThread?: typeof lookupThread;
  /** Finds the thread an unresolved start opened, through T3's protocol and then its CLI; tests stand in for both. */
  recoverThread?: (projectId: string, message: string, known: readonly string[]) => Promise<StartedThread | 'absent' | 'unknown'>;
  /** The project skills selected for the repository as builds start now; tests stand in for the local settings. */
  skillsOf?: (repo: string) => readonly string[];
  /** Reopens the repository's PR `number`; tests stand in for gh and az. */
  reopenPr?: (repo: string, number: number) => Promise<void>;
}

type Action = 'queue' | 'back to List' | 'start' | 'abandon';

/** A status change the board's buttons make: Queue moves List to Queued, Back to List the reverse. */
interface Move {
  action: Action;
  from: Status;
  to: Status;
  refused: (status: Status) => string;
}

const QUEUE: Move = {
  action: 'queue', from: 'List', to: 'Queued',
  refused: (status) => `Only List items can be queued; this one is in ${status}.`,
};

const BACK_TO_LIST: Move = {
  action: 'back to List', from: 'Queued', to: 'List',
  refused: (status) => `Only Queued items can be moved back to List; this one is in ${status}.`,
};

/** A refused Start ran no t3: one of the repository project's checks failed. */
type Start = StartResult & { refused?: true };

const GONE = 'That item is no longer on the board.';

/** Keeps `work` in `inFlight` under `key` until it settles, or for good when `keep` says so. */
function track<T>(inFlight: Map<string, Promise<T>>, key: string, work: Promise<T>, keep: (result: T) => boolean = () => false): Promise<T> {
  const tracked = work.then((result) => {
    if (!keep(result)) inFlight.delete(key);
    return result;
  });
  inFlight.set(key, tracked);
  return tracked;
}

/** Where lar-build is installed, for the build message: under the board app's install root, else the home. */
const larBuild = () => join(installHome(), '.agents/skills/lar-build');

/** The repository project for an onboarded repository as the list is now, so a repository onboarded after a refusal starts on the next Start. */
async function currentRepositoryProject(repo: string): Promise<RepositoryProject> {
  let repos;
  try { repos = readRepositoryList(); }
  catch (err) { return { error: `Can't read the onboarded repositories: ${(err as Error).message}` }; }
  return repositoryProject(repo, repos);
}

/** The thread an unresolved start opened as T3's protocol shows it, else as its CLI does. */
async function recoverStartedThread(projectId: string, message: string, known: readonly string[]): Promise<StartedThread | 'absent' | 'unknown'> {
  try {
    const found = protocolStartedThread(projectId, message, known);
    if (found) return found;
  } catch { /* The CLI reads T3 when the protocol can't. */ }
  return findStartedThread(projectId, message, known);
}

/** The project skills selected for the repository in its local settings, or none. */
function selectedSkills(repo: string): readonly string[] {
  try { return readRepositorySetups().find((setup) => sameRepo(setup.repo, repo))?.skills ?? []; }
  catch { return []; }
}

/** How long T3 may take to show a thread it started before its absence counts. */
const SHOW_GRACE_MS = 60_000;

/** What each kind of start records its thread for, and the board data that shows it. */
const PURPOSES = { started: 'shape', startedBuilds: 'build' } as const;
type StartRecord = keyof typeof PURPOSES;

const MAY_HAVE_STARTED = "This work's last start may have opened a T3 thread. Check the repository's project in T3 Code; the board settles it once T3 shows it.";
const NO_THREAD = "The board asked T3 for a thread, but T3 shows no thread for it. Check the repository's project in T3 Code, then clear Needs you to start again.";

export function createItemCommands({ board, items, records, reread, archive, offerModelChoices, checkSkills, projectOf = currentRepositoryProject,
  showThread = lookupThread, startThread: startIn = startThread, recoverThread = recoverStartedThread, skillsOf = selectedSkills,
  reopenPr = (repo, number) => prHost(repo).reopenPr(prUrl(repo, number)) }: ItemCommandsDeps): ItemCommands {
  const retryBuilds = new Set<string>();
  /** Thread lookups by thread ID: one in flight, or when the next may run. */
  const checks = new Map<string, { pending: boolean; retryAt: number }>();
  /** Recorded threads the T3 CLI confirmed deleted, which no longer hold a start. */
  const deleted = new Set<string>();
  /** The intents whose start is asking T3 now, which only its answer settles. */
  const asking = new Set<string>();
  /** Intent settlements in flight by intent ID, so a refresh and a Start share one. */
  const settling = new Map<string, Promise<Start>>();
  /** Starts by item id. A kept result is reused, so one item starts at most one thread per board run. */
  const starts = new Map<string, Promise<Start>>();
  /** Start builds by item id, kept like Starts, so an item started while Queued can still start its build. */
  const buildStarts = new Map<string, Promise<Start>>();
  // Only settled starts can be retried; requests arriving during a retry share its pending result.
  const finishedStarts = new WeakMap<Promise<Start>, string>();
  const settled = new WeakSet<Promise<Start>>();
  /** Ticket closes by item id: one in flight, so a second press waits for it, or one that succeeded, kept. */
  const closing = new Map<string, Promise<string | null>>();

  const reply = (status: number, body: object): Reply => ({ status, body });
  const withBoard = (status: number, body: object): Reply => reply(status, { ...body, board: board.snapshot() });

  /** Why a command in flight on the item, or a Start this board run, blocks this action; null when nothing does. */
  function busyReason(itemId: string, action: Action): string | null {
    const started = starts.has(itemId) || !!board.snapshot().started?.[itemId] || recordedStart(itemId);
    if (started && action === 'back to List') return 'Start is running or has run for this item. Check its T3 thread before moving it back to List.';
    if (started && action === 'abandon') return 'Start is running or has run for this item. Check its T3 thread before abandoning it.';
    return null;
  }

  /**
   * Moves the item's work record to `to` at the revision the board read: the error to show, null once it moved. A
   * revision a thread moved past refuses and shows the record as it is now; any answer reads the records again.
   */
  function setStatus(item: Item, to: Status): { status: number; error: string } | null {
    if (!records) return { status: 409, error: 'The board has no work records to move.' };
    try {
      records.update(item.id, item.revision, { status: to });
      return null;
    } catch (err) {
      const refused = err instanceof WorkRecordError && (err.code === 'stale-revision' || err.code === 'not-found' || err.code === 'invalid');
      return { status: refused ? 409 : 502, error: (err as Error).message };
    } finally {
      reread();
    }
  }

  function move(itemId: string, { action, from, to, refused }: Move): Reply {
    const item = board.find(itemId);
    if (!item) return reply(404, { error: GONE });
    if (item.status === to) return withBoard(200, { error: null });
    if (item.status !== from) return reply(409, { error: refused(item.status) });
    const busy = busyReason(itemId, action);
    if (busy) return withBoard(409, { error: busy });
    const failed = setStatus(item, to);
    return withBoard(failed?.status ?? 200, { error: failed?.error ?? null });
  }

  /**
   * Refuses a start while the item's repository is still onboarding, until it saves its setup, or while a blocker's work
   * isn't complete; Start after starts it once they complete.
   */
  function blockedReply(item: Item): Reply | null {
    if (isOnboarding(board.snapshot(), item.repo)) return withBoard(409, { error: WAITS_FOR_ONBOARDING });
    const blocked = blockedText(item);
    return blocked ? withBoard(409, { error: `${blocked}; use Start after to start it then.` }) : null;
  }

  /**
   * Runs a start once until its recorded thread stops, keyed in `runs`, on the model choice the
   * board offers now, and records the thread it opened in the board data's `record`. `begin`
   * refuses the item, or returns the work that starts its thread.
   */
  async function startOnce(runs: Map<string, Promise<Start>>, record: StartRecord, itemId: string, model: unknown,
    begin: (item: Item, choice: ModelChoice | undefined) => Reply | (() => Promise<Start>)): Promise<Reply> {
    // Only a choice the board offers right now reaches t3 as arguments.
    let choice: ModelChoice | undefined;
    if (model !== undefined) {
      const found = findModelChoice(offerModelChoices(), model);
      if (!found) return withBoard(422, { error: "That model choice isn't offered. Pick another one." });
      choice = found;
    }
    let pending = runs.get(itemId);
    const item = board.find(itemId);
    const previous = pending && finishedStarts.get(pending);
    if (previous && Array.isArray(item?.threads) && item.threads.some((t) => t.id === previous && t.state === 'stopped')
      && !item.threads.some((t) => t.state === 'running' || t.state === 'needs you')) {
      runs.delete(itemId);
      pending = undefined;
    }
    // With work records, the record guards a settled start, so each press reads it again.
    if (records && pending && settled.has(pending)) {
      runs.delete(itemId);
      pending = undefined;
    }
    if (!pending) {
      const item = board.find(itemId);
      if (!item) return reply(404, { error: GONE });
      const work = begin(item, choice);
      if (typeof work !== 'function') return work;
      // Keep a started or unconfirmed thread; only a confirmed stop or a failure reported by t3 allows retry.
      pending = track(runs, itemId, work().then((result) => {
        settled.add(pending!);
        if (result.thread) finishedStarts.set(pending!, result.thread.threadId);
        if (result.thread) board.update({ [record]: { ...board.snapshot()[record], [itemId]: result.thread } } satisfies Partial<BoardData>);
        board.push();
        return result;
      }), (result) => !!result.thread || !!result.uncertain);
    }
    const { refused, ...result } = await pending;
    return withBoard(refused ? 409 : result.error ? 502 : 200, result);
  }

  /** The threads the item's work record holds; none without records or a record. */
  function recordedThreads(workId: string) {
    try { return records?.threads(workId) ?? []; }
    catch { return []; }
  }

  /** Whether the work record holds a thread or an unresolved launch intent. */
  function recordedStart(workId: string): boolean {
    return recordedThreads(workId).length > 0 || !!records?.launchIntents({ workId, unresolved: true }).length;
  }

  /** Whether the work's recorded PR is observed closed unmerged, so its build starts again as a replacement. */
  function prClosed(workId: string): boolean {
    try { return records?.observations(workId).some((o) => o.of === 'pr' && o.state === 'closed') ?? false; }
    catch { return false; }
  }

  /** Writes a change to the item's work record at its current revision, then shows the records again. */
  function write<T>(workId: string, change: (revision: number) => T): T {
    try { return change(records!.read(workId).revision); }
    finally { reread(); }
  }

  /**
   * Settles an unresolved launch intent through T3: to the thread T3 shows for it, to a failure with Needs you once T3
   * shows none after SHOW_GRACE_MS, or not yet while T3 can't answer.
   */
  function settle(item: Item, intent: LaunchIntent, projectId: string, message: string): Promise<Start> {
    const running = settling.get(intent.intentId);
    if (running) return running;
    return track(settling, intent.intentId, (async (): Promise<Start> => {
      const known = records!.threads(item.id).map((t) => t.threadId);
      let found: Awaited<ReturnType<typeof recoverThread>>;
      try { found = await recoverThread(projectId, message, known); } catch { found = 'unknown'; }
      if (typeof found === 'object') {
        write(item.id, (revision) => records!.resolveLaunchIntent(item.id, revision, intent.intentId, { threadId: found.threadId }));
        return { thread: found, error: null };
      }
      if (found === 'absent' && Date.now() - Date.parse(intent.requestedAt) >= SHOW_GRACE_MS) {
        write(item.id, (revision) => records!.resolveLaunchIntent(item.id, revision, intent.intentId, { failure: NO_THREAD }));
        write(item.id, (revision) => records!.setNeedsYou(item.id, revision, NO_THREAD));
        return { thread: null, error: `Needs you: ${NO_THREAD}`, refused: true };
      }
      return { thread: null, error: MAY_HAVE_STARTED, uncertain: true };
    })());
  }

  /**
   * The thread the work record already holds for `purpose`: one not confirmed stopped or deleted, with the item's
   * threads as T3 shows them. Null when every one stopped or was deleted, so a start may run again.
   */
  function heldThread(item: Item, purpose: string): StartedThread | null {
    for (const { threadId } of records!.threads(item.id).filter((t) => t.purpose === purpose).reverse()) {
      if (deleted.has(threadId)) continue;
      const shown = Array.isArray(item.threads) ? item.threads.find((t) => t.id === threadId) : undefined;
      if (shown?.state === 'stopped') continue;
      return { threadId, title: shown?.title ?? item.title };
    }
    return null;
  }

  /**
   * Starts the item's thread for `record` through `ask`, guarded by its work record: a held or unresolved start answers
   * for it, Needs you and a paused setup refuse it, and a launch intent is on the record before `ask` runs. Without records, `ask` alone.
   */
  async function launch(item: Item, record: StartRecord, projectId: string, message: string, ask: () => Promise<StartResult>,
    prepare: () => void = () => {}): Promise<Start> {
    if (!records) return ask();
    const purpose = PURPOSES[record];
    const unresolved = records.launchIntents({ workId: item.id, unresolved: true }).find((intent) => intent.purpose === purpose);
    if (unresolved) return settle(item, unresolved, projectId, message);
    const needsYou = records.read(item.id).needsYou;
    if (needsYou) return { thread: null, error: `Needs you: ${needsYou}`, refused: true };
    const paused = (board.find(item.id) ?? item).paused;
    if (paused) return { thread: null, error: `Paused: ${paused}`, refused: true };
    // A build whose PR closed unmerged starts a replacement, so the thread that opened that PR holds no start.
    const held = record === 'startedBuilds' && prClosed(item.id) ? null : heldThread(board.find(item.id) ?? item, purpose);
    const shown = board.snapshot()[record]?.[item.id];
    if (held) return { thread: shown?.threadId === held.threadId ? shown : held, error: null };
    prepare();
    const { intent } = write(item.id, (revision) => records.recordLaunchIntent(item.id, revision, purpose));
    asking.add(intent.intentId);
    const result = await ask().finally(() => asking.delete(intent.intentId));
    const outcome = result.thread ? { threadId: result.thread.threadId } : !result.uncertain ? { failure: result.error ?? 'T3 started no thread.' } : null;
    // An outcome the record refuses leaves the intent unresolved, for a refresh to settle through T3.
    if (outcome) try { write(item.id, (revision) => records.resolveLaunchIntent(item.id, revision, intent.intentId, outcome)); } catch { /* settled later */ }
    return result;
  }

  /** When each unresolved intent may be settled again on a refresh, by intent ID. */
  const settleAt = new Map<string, number>();

  /** Settles the item's unresolved launch intents, each at most every 30 seconds, and shows a thread T3 shows for one. */
  async function settleIntents(item: Item): Promise<void> {
    let intents: LaunchIntent[];
    try { intents = records?.launchIntents({ workId: item.id, unresolved: true }) ?? []; }
    catch { return; }
    for (const intent of intents) {
      if (asking.has(intent.intentId) || Date.now() < (settleAt.get(intent.intentId) ?? -Infinity)) continue;
      settleAt.set(intent.intentId, Date.now() + 30_000);
      const record: StartRecord = intent.purpose === PURPOSES.startedBuilds ? 'startedBuilds' : 'started';
      const repoProject = await projectOf(item.repo);
      if (repoProject.error !== undefined) continue;
      const message = record === 'startedBuilds' ? buildMessage(item, larBuild()) : workMessage(item);
      const { thread } = await settle(item, intent, repoProject.projectId, message);
      if (thread) board.update({ [record]: { ...board.snapshot()[record], [item.id]: thread } } satisfies Partial<BoardData>);
      board.push();
    }
  }

  /** Moves the item's parent record to In progress, unless it's a build or there already: the error to show, else null. */
  function parentInProgress({ parentId }: Item): string | null {
    const parent = parentId ? board.find(parentId) : undefined;
    if (!parent || parent.kind === 'build' || parent.status === 'In progress') return null;
    return setStatus(parent, 'In progress')?.error ?? null;
  }

  return {
    async reconcileStarts(currentItems) {
      const warnings = { ...board.snapshot().startCheckFailures };
      for (const id of Object.keys(warnings)) if (!currentItems.some((item) => item.id === id)) delete warnings[id];
      if (JSON.stringify(warnings) !== JSON.stringify(board.snapshot().startCheckFailures ?? {})) {
        board.update({ startCheckFailures: warnings });
        board.push();
      }
      const runsOf = { started: starts, startedBuilds: buildStarts };
      // Each thread a start opened this board run or the record holds, which an available read may lack.
      const missing = currentItems.flatMap((item) => {
        if (!Array.isArray(item.threads)) return [];
        const shown = item.threads;
        const ids = new Map<string, StartRecord>();
        for (const record of ['started', 'startedBuilds'] as const) {
          const run = runsOf[record].get(item.id);
          const threadId = run && finishedStarts.get(run);
          if (threadId) ids.set(threadId, record);
        }
        for (const { threadId, purpose } of recordedThreads(item.id)) {
          if (!ids.has(threadId) && !deleted.has(threadId)) ids.set(threadId, purpose === PURPOSES.startedBuilds ? 'startedBuilds' : 'started');
        }
        return [...ids].map(([threadId, record]) => ({ item, threadId, record, shown: shown.some((thread) => thread.id === threadId) }));
      });
      const clearWarning = (id: string) => {
        const failures = { ...board.snapshot().startCheckFailures };
        if (!(id in failures)) return;
        delete failures[id];
        board.update({ startCheckFailures: failures });
        board.push();
      };
      await Promise.all([...missing.map(async ({ item, threadId, record, shown }) => {
        const id = item.id;
        if (shown) return clearWarning(id);
        const previous = checks.get(threadId);
        if (previous?.pending || (previous && Date.now() < previous.retryAt)) return;
        checks.set(threadId, { pending: true, retryAt: Infinity });
        let answer: Awaited<ReturnType<typeof lookupThread>>;
        try { answer = await showThread(threadId); } catch { answer = 'unknown'; }
        checks.set(threadId, { pending: false, retryAt: answer === 'unknown' ? Date.now() + 30_000 : Infinity });
        if (!board.find(id)) return;
        const failures = { ...board.snapshot().startCheckFailures };
        if (answer === 'unknown') failures[id] = item.title;
        else delete failures[id];
        if (answer === 'deleted') {
          deleted.add(threadId);
          const runs = runsOf[record];
          const run = runs.get(id);
          if (run && finishedStarts.get(run) === threadId) {
            runs.delete(id);
            finishedStarts.delete(run);
          }
          if (record === 'startedBuilds') retryBuilds.add(id);
          if (board.snapshot()[record]?.[id]?.threadId === threadId) {
            const shownStarts = { ...board.snapshot()[record] };
            delete shownStarts[id];
            board.update({ [record]: shownStarts });
          }
        }
        board.update({ startCheckFailures: failures });
        board.push();
      }), ...currentItems.map((item) => settleIntents(item))]);
    },
    queue: (itemId) => move(itemId, QUEUE),
    backToList: (itemId) => move(itemId, BACK_TO_LIST),

    start: (itemId, model) => startOnce(starts, 'started', itemId, model, (item, choice) => {
      if (item.status !== 'Queued') return reply(409, { error: `Only Queued items can be started; this one is in ${item.status}.` });
      const busy = busyReason(itemId, 'start');
      if (busy) return withBoard(409, { error: busy });
      const blocked = blockedReply(item);
      if (blocked) return blocked;
      const message = workMessage(item);
      const repo = item.repo;
      return async () => {
        const repoProject = await projectOf(repo);
        if (repoProject.error !== undefined) return { thread: null, error: repoProject.error, refused: true };
        return launch(item, 'started', repoProject.projectId, message, () => startIn(repoProject.projectId, message, choice));
      };
    }),

    startBuild: (itemId, model, drift) => startOnce(buildStarts, 'startedBuilds', itemId, model, (item, choice) => {
      if (drift !== undefined && !isDriftChoice(drift)) return reply(422, { error: 'Choose Replace and start or Start anyway.' });
      if (item.status !== 'Ready') return reply(409, { error: `Only Ready items can start a build; this one is in ${item.status}.` });
      const busy = busyReason(itemId, 'start');
      if (busy) return withBoard(409, { error: busy });
      const blocked = blockedReply(item);
      if (blocked) return blocked;
      const message = buildMessage(item, larBuild());
      const previous = board.snapshot().startedBuilds?.[itemId];
      const retry = retryBuilds.has(itemId) || previous && Array.isArray(item.threads) && item.threads.some((t) => t.id === previous.threadId && t.state === 'stopped')
        || recordedThreads(itemId).some((t) => t.purpose === PURPOSES.startedBuilds) || prClosed(itemId);
      const branch = `${buildBranch(item)}${retry ? `-retry-${randomUUID().slice(0, 8)}` : ''}`;
      const { repo } = item;
      return async () => {
        // A refusal comes before any write, so a build that can't start changes nothing on GitHub.
        const skills = await checkSkills?.(drift);
        if (skills?.refusal) return { thread: null, error: skills.refusal, refused: true, ...skills.drift && { drift: skills.drift } };
        const repoProject = await projectOf(repo);
        if (repoProject.error !== undefined) return { thread: null, error: repoProject.error, refused: true };
        const error = parentInProgress(item);
        if (error) return { thread: null, error };
        // A build snapshots its skills once, so a retry keeps the selection its first start saw.
        const snapshot = () => {
          if (records!.read(item.id).skills === null) write(item.id, (revision) => records!.snapshotSkills(item.id, revision, skillsOf(repo)));
        };
        return launch(item, 'startedBuilds', repoProject.projectId, message, () => startIn(repoProject.projectId, message, choice, { base: 'main', branch }), snapshot);
      };
    }),

    abandon(itemId) {
      const item = board.find(itemId);
      // A second press after Abandon finished has nothing left to do.
      if (!item && board.removed(itemId)) return withBoard(200, { error: null });
      if (!item) return withBoard(404, { error: GONE });
      // Needs you offers setting work aside whatever its Status and threads, as after its PR closed unmerged.
      const offered = item.needsYou?.offers.includes('set-aside');
      if (!canAbandon(item) && !offered) return reply(409, { error: `Only List and Queued items can be abandoned; this one is in ${item.status}.` });
      const busy = offered ? null : busyReason(itemId, 'abandon');
      if (busy) return withBoard(409, { error: busy });
      if (records) {
        try { records.setAside(item.id, item.revision); }
        catch (err) {
          reread();
          return withBoard(409, { error: (err as Error).message });
        }
      }
      board.remove(itemId);
      reread();
      return withBoard(200, { error: null });
    },

    async closeTicket(itemId) {
      const kept = closing.get(itemId);
      if (kept) {
        const error = await kept;
        return withBoard(error ? 502 : 200, { error });
      }
      const item = archive().find((shown) => shown.id === itemId);
      if (!item?.archived?.setAside) return withBoard(409, { error: "That work isn't set aside, so the board closes no ticket. Abandon it first." });
      if (!item.number) return withBoard(409, { error: 'That work has no ticket to close.' });
      if (item.abandonRefusal) return withBoard(409, { error: item.abandonRefusal });
      if (!item.archived.ticketOpen) return withBoard(409, { error: "The board doesn't see that work's ticket open, so it closes nothing. Check it in its provider." });
      const error = await track(closing, itemId, items.abandon(item), (failed) => failed === null);
      return withBoard(error ? 502 : 200, { error });
    },

    restore(itemId) {
      if (!records) return withBoard(409, { error: 'The board has no work records to change.' });
      if (!archive().some((shown) => shown.id === itemId && shown.archived?.setAside)) {
        return withBoard(409, { error: "That work isn't set aside in Archive, so there is nothing to restore." });
      }
      try { write(itemId, (revision) => records.restore(itemId, revision)); }
      catch (err) { return withBoard(409, { error: (err as Error).message }); }
      return withBoard(200, { error: null });
    },

    async resolveNeedsYou(itemId, choice) {
      const item = board.find(itemId);
      if (!item) return reply(404, { error: GONE });
      if (!records) return withBoard(409, { error: 'The board has no work records to change.' });
      if (!item.needsYou) return withBoard(409, { error: "That work doesn't need you." });
      const offered = choice === 'clear' || (choice !== 'set-aside' && item.needsYou.offers.some((offer) => offer === choice));
      if (!offered) return withBoard(409, { error: 'Pick one of the choices the board offers for this work.' });
      try {
        if (choice === 'reopen-pr') {
          const pullRequest = records.read(itemId).pullRequest!;
          await reopenPr(item.repo, Number(pullRequest.slice(pullRequest.lastIndexOf('#') + 1)));
        }
        write(itemId, (revision) => records.clearNeedsYou(itemId, revision));
        if (choice === 'replace-pr') write(itemId, (revision) => records.update(itemId, revision, { status: 'Ready' }));
        if (choice === 'reopen-work') write(itemId, (revision) => records.update(itemId, revision, { status: 'List' }));
      } catch (err) {
        reread();
        return withBoard(err instanceof WorkRecordError ? 409 : 502, { error: (err as Error).message });
      }
      return withBoard(200, { error: null });
    },

    markDependencyMet(itemId, dependencyId, revision, met) {
      const item = board.find(itemId);
      if (!item) return reply(404, { error: GONE });
      if (!records) return withBoard(409, { error: 'The board has no work records to change.' });
      if (!item.blockers.some((b) => b.dependency?.dependencyId === dependencyId)) return withBoard(409, { error: "That Dependency doesn't hold this work." });
      if (typeof met !== 'boolean') return withBoard(400, { error: 'Say whether the Dependency is met.' });
      let refused: Error | null = null;
      try {
        if (met) records.markDependencyMet(dependencyId as string, revision as number, userInfo().username);
        else records.clearDependencyMet(dependencyId as string, revision as number);
      } catch (err) {
        refused = err as Error;
      }
      reread();
      return refused ? withBoard(refused instanceof WorkRecordError ? 409 : 500, { error: refused.message }) : withBoard(200, { error: null });
    },
  };
}
