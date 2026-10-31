// The board's HTTP side: serves the page and the board data on this machine only,
// streams changes over /api/events, and routes the page's writes to the item commands.

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, timingSafeEqual } from 'node:crypto';
import { pageWithData, sameRepo, type Item, type ImportableTicket, type ItemCommentsPage, type ItemDetails, type OnboardingPrChange, type OnboardingRepository, type ProjectChoice, type RepoConfig, type RepositorySetup, type SetupDetection, type TicketsImported } from '@lar-factory/shared';
import type { PublicationSettings } from '@lar-factory/shared/publication-settings';
import type { BoardState } from '../board/board-state.ts';
import type { Refused } from '../config/edit-config.ts';
import { isRepo } from '../config/repository-config.ts';
import type { Capture } from '../items/capture.ts';
import type { BoardRetention } from '../items/retention.ts';
import type { ItemCommands, Reply } from '../items/item-commands.ts';
import type { ItemDetailsReader } from '../item-details/item-details.ts';
import type { BuiltPage } from '../page/page.ts';
import type { StartAfter } from '../start-after/start-after.ts';
import { log } from '../log.ts';
import { readAzureReadiness } from '../azure/azure-readiness.ts';

import type { createPublication } from '../publication/publication.ts';

export interface HttpDeps {
  publication: ReturnType<typeof createPublication>;
  board: BoardState;
  commands: ItemCommands;
  capture: Capture;
  startAfter: StartAfter;
  retention: Pick<BoardRetention, 'save'>;
  /** Archive's work as the records are now, which Settings › Archive reads from /api/archive when it opens. */
  archive(): Item[];
  page: BuiltPage;
  /** Set by the board app on each launch; while set, guarded writes must carry it in X-Board-Secret. */
  appSecret: string | null;
  /** Sample mode serves a fixed file: it writes nothing and runs no tools. */
  sample: boolean;
  /** Looks the tools up again, az too when `az` asks for it, as onboarding an Azure DevOps repository does. */
  reauthorizeT3?(): Promise<void>;
  recheck(options?: { gh?: boolean; az?: boolean }): Promise<void>;
  /** Reads one item's details and older comments for the item dialog, and exports its record's markdown. */
  itemDetails: ItemDetailsReader;
  /**
   * Reads the source listing the item at `url` now, or once more after the running read; with no url, loads the
   * repositories' configs again and reads every source.
   */
  readSoon(url?: string): void;
  /** The startup tool check; requests other than /healthz and assets wait for it. */
  ready(): Promise<void> | undefined;
  /** T3's projects as onboarding's T3 project step offers them; throws when they can't be read. */
  projectChoices(): Promise<ProjectChoice[]>;
  /** Stores where a closed onboarding stopped, returning the repositories still onboarding, or why it can't. */
  keepOnboarding(input: Record<string, unknown>): Promise<{ onboarding: OnboardingRepository[] } | Refused>;
  /** Adds the body's folder as a T3 project, returning T3's projects and the new one's id, or why it can't. */
  createProject(input: Record<string, unknown>): Promise<{ projects: ProjectChoice[]; projectId: string } | Refused>;
  /** Onboarding's detection of the body's repository with its T3 project, reading only, or why it can't run. */
  detectSetup(input: Record<string, unknown>): Promise<{ detection: SetupDetection } | Refused>;
  /** Saves onboarding's answers as the body's repository's local settings, returning the repositories still onboarding, or why it can't. */
  saveSetup(input: Record<string, unknown>): Promise<{ onboarding: OnboardingRepository[] } | Refused>;
  /** The body's repository's open tickets carrying a status label or tag, which onboarding offers to import, or why it can't list them. */
  importableTickets(input: Record<string, unknown>): Promise<{ tickets: ImportableTicket[] } | Refused>;
  /** Imports the body's chosen tickets as work records, reporting each one, or why it can't import. */
  importTickets(input: Record<string, unknown>): Promise<TicketsImported | Refused>;
  /** Opens the PR with the repository edits onboarding's user approved, returning its URL, or gh's or az's problem. */
  openOnboardingPr(input: Record<string, unknown>): Promise<{ prUrl: string } | Refused>;
  /** What an onboarding's PR would change against its default branch with the body's edits and picks, or why it can't say. */
  previewOnboardingPr(input: Record<string, unknown>): Promise<{ changes: OnboardingPrChange[] } | Refused>;
  /** The config update notice's PR: rewrites the body's repository's .lar-factory.json at the app's version through Edit's PR, returning its URL, or gh's problem. */
  openConfigUpdatePr(input: Record<string, unknown>): Promise<{ prUrl: string } | Refused>;
  /** Records the repository's config update notice dismissed at the app's version, on this Mac, or says why it can't for a repository that isn't onboarded. */
  dismissConfigUpdate(repo: string): Refused | null;
  /** Sets or removes a local override, accepts a changed setup or rechecks access for the body's repository, answering its setup, or why it can't. */
  publicationVocabulary(repo: unknown): Promise<PublicationSettings | Refused>;
  changeRepositorySettings(input: Record<string, unknown>): { setup: RepositorySetup } | Refused;
}

export interface BoardServer {
  server: Server;
  /** Ends every page's event stream, so the server can close. */
  endStreams(): void;
}

/** A write only the board app's page may make. */
interface Write {
  /** What the body holds, for the errors about it. */
  what: string;
  /** The refusal in sample mode, before the body is read. */
  disabled?: string;
  /** The answer when the page's session is from an earlier board run; a write without one skips the check. */
  restarted?: () => object;
  run(input: Record<string, unknown>): Promise<Reply>;
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'",
};

function send(res: ServerResponse, status: number, type: string, body: string | Buffer): void {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
  res.end(body);
}

function json(res: ServerResponse, status: number, value: unknown): void {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(value));
}

/** Whether the request carries the app secret, compared in constant time. Hashing first evens out the lengths. */
function hasAppSecret(req: IncomingMessage, secret: string): boolean {
  const given = req.headers['x-board-secret'];
  if (typeof given !== 'string') return false;
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(given), digest(secret));
}

/** Reads a small JSON object body, or answers the request with the problem and returns null. */
async function readJson(req: IncomingMessage, res: ServerResponse, what: string): Promise<Record<string, unknown> | null> {
  if (req.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') {
    json(res, 415, { error: `Send ${what} as JSON.` });
    return null;
  }
  try {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > 100_000) {
        json(res, 413, { error: `${what[0]!.toUpperCase()}${what.slice(1)} are too large.` });
        return null;
      }
      chunks.push(chunk as Buffer);
    }
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    if (!input || typeof input !== 'object') throw new Error('Invalid JSON.');
    return input as Record<string, unknown>;
  } catch {
    json(res, 400, { error: `Send valid ${what} as JSON.` });
    return null;
  }
}

/** Runs an item command on the body's itemId, or refuses a body that names none. */
function forItem(unnamed: string, run: (itemId: string, input: Record<string, unknown>) => Reply | Promise<Reply>): Write['run'] {
  return async (input) => typeof input.itemId === 'string' ? run(input.itemId, input) : { status: 400, body: { error: unnamed } };
}

export function createBoardServer({ board, commands, capture, startAfter, retention, archive, page, appSecret, sample, recheck, reauthorizeT3, itemDetails, readSoon, ready, projectChoices, keepOnboarding, createProject,
  detectSetup, saveSetup, importableTickets, importTickets, openOnboardingPr, previewOnboardingPr, openConfigUpdatePr, dismissConfigUpdate, changeRepositorySettings, publicationVocabulary, publication }: HttpDeps): BoardServer {
  /** Open /api/events responses, one per page. */
  const streams = new Set<ServerResponse>();
  /** Set once the app asks to drain before installing an update: guarded writes are refused from then on. */
  let draining = false;
  /** Guarded writes being answered, and the drain calls waiting for them to finish. */
  let runningWrites = 0;
  const drained: Array<() => void> = [];

  const withBoard = (body: object) => ({ ...body, board: board.snapshot() });

  /** Changes the repository's row on the board at once, before the next read sees it. */
  function changeRow(repo: string, change: (row: RepoConfig) => RepoConfig): void {
    board.update({ repos: board.snapshot().repos.map((r) => sameRepo(r.repo, repo) ? change(r) : r) });
    board.push();
  }

  /**
   * Records the repository's config update notice dismissed and takes it off its row at once, with `changes` to the row;
   * or answers why it can't.
   */
  function dismissNotice(repo: string, changes: object = {}): Refused | null {
    const refused = dismissConfigUpdate(repo);
    if (refused) return refused;
    changeRow(repo, ({ configUpdate: _, ...r }) => ({ ...r, ...changes }));
    return null;
  }

  /** The guarded writes by path. /api/read stays open for status.sh, since it only starts a read. */
  const WRITES: Record<string, Write> = {
    ...Object.fromEntries(['open', 'prepare', 'approve', 'inspect', 'resume', 'reconcile', 'fallback', 'resolve-url', 'attach-url', 'reconcile-url', 'resolve-outcome', 'retry'].map((action) => [`/api/publication/${action}`, {
      what: 'the publication request', disabled: 'Publishing is disabled in sample mode. Your private work remains available.',
      restarted: () => ({ error: 'The board restarted. Reopen publication to inspect its stored plan.' }),
      run: (input: Record<string, unknown>) => publication.request(action, input),
    }])),
    '/api/pr-readiness': {
      what: 'the linked PR to read', disabled: 'Azure readiness is unavailable in sample mode.',
      async run({ itemId, number }) {
        const item = board.snapshot().items.find((i) => i.id === itemId);
        const pr = item?.linkedPrs.find((p) => p.number === number);
        if (!item || !pr || !item.azure) return { status: 404, body: { error: 'That Azure PR is not on the board.' } };
        if (board.snapshot().itemSourceProblems?.some((p) => p.repo === item.repo)) return { status: 503, body: { error: 'The Azure source is disconnected.' } };
        // Resolve arguments from the board's provider link, never arbitrary client arguments.
        const match = /^https:\/\/dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+)\/pullrequest\/(\d+)$/i.exec(pr.url);
        if (!match || Number(match[4]) !== number) return { status: 400, body: { error: 'This Azure PR link is unsupported.' } };
        const evidence = await readAzureReadiness(match[1]!, decodeURIComponent(match[2]!), decodeURIComponent(match[3]!), Number(number));
        if (board.snapshot().itemSourceProblems?.some((p) => p.repo === item.repo)) return { status: 503, body: { error: 'The Azure source is disconnected.' } };
        return { status: 200, body: { evidence: evidence.available ? evidence : { available: false, reason: 'Azure evidence is unavailable. Check the provider connection and refresh.' }, error: null } };
      },
    },
    '/api/items': {
      what: 'item details', disabled: 'Adding items is disabled in sample mode.',
      restarted: () => ({ uncertain: true, error: 'The board restarted. Check List for this item before adding it again.' }),
      run: (input) => capture.capture(input),
    },
    '/api/pick-ticket': {
      what: 'the repository and the ticket to pick', disabled: 'Picking tickets is disabled in sample mode.',
      run: (input) => capture.pick(input),
    },
    '/api/attach-ticket': {
      what: 'the item and the ticket to attach', disabled: 'Attaching tickets is disabled in sample mode.',
      run: forItem('Name the item to attach a ticket to.', (itemId, input) => capture.attachTicket(itemId, input.number)),
    },
    '/api/queue': {
      what: 'the item to queue', disabled: 'Queuing is disabled in sample mode.',
      run: forItem('Name the item to queue.', (itemId) => commands.queue(itemId)),
    },
    '/api/back-to-list': {
      what: 'the item to move back to List', disabled: 'Moving items back to List is disabled in sample mode.',
      run: forItem('Name the item to move back to List.', (itemId) => commands.backToList(itemId)),
    },
    '/api/start': {
      what: 'the item to start', disabled: 'Starting threads is disabled in sample mode.',
      restarted: () => withBoard({ error: 'The board restarted. Press Start again.' }),
      run: forItem('Name the item to start.', (itemId, input) => commands.start(itemId, input.model)),
    },
    '/api/start-build': {
      what: 'the build to start', disabled: 'Starting builds is disabled in sample mode.',
      restarted: () => withBoard({ error: 'The board restarted. Press Start build again.' }),
      run: forItem('Name the build to start.', (itemId, input) => commands.startBuild(itemId, input.model, input.drift)),
    },
    '/api/arm': {
      what: 'the item to start after its blockers', disabled: 'Start after is disabled in sample mode.',
      restarted: () => withBoard({ error: 'The board restarted. Press Start after again.' }),
      run: forItem('Name the item to start after its blockers.', async (itemId, input) => startAfter.arm(itemId, input.model)),
    },
    '/api/disarm': {
      what: 'the item to disarm', disabled: 'Start after is disabled in sample mode.',
      run: forItem('Name the item to disarm.', async (itemId) => startAfter.disarm(itemId)),
    },
    '/api/abandon': {
      what: 'the item to abandon', disabled: 'Abandoning is disabled in sample mode.',
      restarted: () => withBoard({ error: 'The board restarted. Press Abandon again.' }),
      run: forItem('Name the item to abandon.', (itemId) => commands.abandon(itemId)),
    },
    '/api/close-ticket': {
      what: 'the abandoned item whose ticket to close', disabled: 'Closing tickets is disabled in sample mode.',
      run: forItem('Name the item whose ticket to close.', (itemId) => commands.closeTicket(itemId)),
    },
    '/api/restore': {
      what: 'the set-aside item to restore', disabled: 'Restoring is disabled in sample mode.',
      run: forItem('Name the item to restore.', async (itemId) => commands.restore(itemId)),
    },
    '/api/retention': {
      what: 'the retention setting', disabled: 'Retention is disabled in sample mode.',
      async run(input) {
        const saved = retention.save(input);
        return { ...saved, body: { ...saved.body, board: board.snapshot() } };
      },
    },
    '/api/needs-you': {
      what: 'the item that needs you and the choice', disabled: 'Acting on Needs you is disabled in sample mode.',
      run: forItem('Name the item that needs you.', (itemId, input) => commands.resolveNeedsYou(itemId, input.choice)),
    },
    '/api/dependency-met': {
      what: 'the Dependency to mark', disabled: 'Marking a Dependency met is disabled in sample mode.',
      run: forItem('Name the item the Dependency holds.', async (itemId, input) => {
        const marked = commands.markDependencyMet(itemId, input.dependencyId, input.revision, input.met);
        // A met mark can release an armed start at once, with no read to wait for.
        if (marked.status === 200) await startAfter.startUnblocked();
        return marked;
      }),
    },
    '/api/item-description': {
      what: 'the description and its item', disabled: 'Saving descriptions is disabled in sample mode.',
      async run({ itemId, body, bodyField, revision }) {
        if (typeof itemId !== 'string' || !itemId || typeof body !== 'string') return { status: 400, body: { error: 'Name the item and send its description.' } };
        if ((bodyField !== undefined && bodyField !== 'System.Description' && bodyField !== 'Microsoft.VSTS.TCM.ReproSteps')
          || (revision !== undefined && !Number.isSafeInteger(revision))) return { status: 400, body: { error: 'Send the field and revision the work item\'s details gave.' } };
        const item = board.snapshot().items.find((i) => i.id === itemId);
        if (!item) return { status: 404, body: { error: 'That item is not on the board.' } };
        // Saving writes the ticket, which waits on this Mac's consent to edit the repository's tickets.
        if (!board.snapshot().repos.find((r) => sameRepo(r.repo, item.repo))?.setup?.consent.includes('edit-ticket')) {
          return { status: 403, body: { error: `Editing tickets is off for ${item.repo}. Turn on its Offer under Access in Settings › Repositories › Edit.` } };
        }
        const refused = await itemDetails.saveDescription(item, { body, ...bodyField !== undefined && { bodyField }, ...revision !== undefined && { revision: revision as number } });
        return refused ? { status: refused.status, body: { error: refused.error } } : { status: 200, body: { error: null } };
      },
    },
    '/api/item-export': {
      what: 'the item to export', disabled: 'Exporting is disabled in sample mode.',
      run: forItem('Name the item to export.', async (itemId) => {
        const item = board.snapshot().items.find((i) => i.id === itemId) ?? archive().find((i) => i.id === itemId);
        if (!item) return { status: 404, body: { error: 'That item is not on the board or in Archive.' } };
        const exported = await itemDetails.exportMarkdown(item);
        return 'error' in exported ? { status: exported.status, body: { error: exported.error } } : { status: 200, body: { ...exported, error: null } };
      }),
    },
    '/api/onboarding/projects': {
      what: 'the folder to add', disabled: 'Sample mode onboards no repository.',
      async run(input) {
        const created = await createProject(input);
        return 'error' in created ? { status: created.status, body: { error: created.error } } : { status: 200, body: { ...created, error: null } };
      },
    },
    '/api/onboarding/repositories': {
      what: 'the onboarding to keep', disabled: 'Sample mode onboards no repository.',
      async run(input) {
        const kept = await keepOnboarding(input);
        if ('error' in kept) return { status: kept.status, body: { error: kept.error } };
        board.update({ onboarding: kept.onboarding });
        board.push();
        return { status: 200, body: withBoard({ error: null }) };
      },
    },
    '/api/onboarding/detect': {
      what: 'the repository whose setup to detect', disabled: 'Sample mode onboards no repository.',
      async run(input) {
        const detected = await detectSetup(input);
        return 'error' in detected ? { status: detected.status, body: { error: detected.error } } : { status: 200, body: { ...detected, error: null } };
      },
    },
    '/api/onboarding/import/tickets': {
      what: 'the repository whose tickets to list', disabled: 'Sample mode onboards no repository.',
      async run(input) {
        const listed = await importableTickets(input);
        return 'error' in listed ? { status: listed.status, body: { error: listed.error } } : { status: 200, body: { ...listed, error: null } };
      },
    },
    // The board shows the imported records at once when the repository is already on it.
    '/api/onboarding/import': {
      what: 'the tickets to import', disabled: 'Sample mode onboards no repository.',
      async run(input) {
        const imported = await importTickets(input);
        if ('error' in imported) return { status: imported.status, body: { error: imported.error } };
        return { status: 200, body: withBoard({ ...imported, error: null }) };
      },
    },
    // The repository goes on the board with its local settings, and the next read loads its items.
    '/api/onboarding/setup': {
      what: 'the answers to save', disabled: 'Sample mode onboards no repository.',
      async run(input) {
        const saved = await saveSetup(input);
        if ('error' in saved) return { status: saved.status, body: { error: saved.error } };
        board.update({ onboarding: saved.onboarding });
        board.push();
        readSoon();
        return { status: 200, body: withBoard({ error: null }) };
      },
    },
    '/api/onboarding/pr': {
      what: 'the repository edits to open a PR with', disabled: 'Sample mode onboards no repository.',
      async run(input) {
        const opened = await openOnboardingPr(input);
        return 'error' in opened ? { status: opened.status, body: { error: opened.error } } : { status: 200, body: { ...opened, error: null } };
      },
    },
    '/api/onboarding/pr/changes': {
      what: 'the repository edits to preview', disabled: 'Sample mode onboards no repository.',
      async run(input) {
        const previewed = await previewOnboardingPr(input);
        return 'error' in previewed ? { status: previewed.status, body: { error: previewed.error } } : { status: 200, body: { ...previewed, error: null } };
      },
    },
    // A config update PR the notice opened takes the notice's place, as the row's open Edit PR.
    '/api/repositories/config-update/pr': {
      what: 'the repository to update', disabled: 'Sample mode edits no repository.',
      async run(input) {
        const opened = await openConfigUpdatePr(input);
        if ('error' in opened) return { status: opened.status, body: { error: opened.error } };
        dismissNotice(input.repo as string, { editPr: opened.prUrl });
        return { status: 200, body: withBoard({ ...opened, error: null }) };
      },
    },
    '/api/repositories/config-update/dismiss': {
      what: 'the repository whose notice to dismiss', disabled: 'Sample mode edits no repository.',
      async run({ repo }) {
        if (!isRepo(repo)) return { status: 400, body: { error: 'Send the repository whose notice to dismiss.' } };
        const refused = dismissNotice(repo);
        if (refused) return { status: refused.status, body: { error: refused.error } };
        return { status: 200, body: withBoard({ error: null }) };
      },
    },
    // The row shows the new setup at once; the read after it shows what the setup changes, such as paused work.
    '/api/repositories/settings': {
      what: 'the repository and the change to its settings', disabled: 'Sample mode changes no repository settings.',
      async run(input) {
        const changed = changeRepositorySettings(input);
        if ('error' in changed) return { status: changed.status, body: { error: changed.error } };
        changeRow(input.repo as string, (r) => ({ ...r, setup: changed.setup }));
        readSoon();
        return { status: 200, body: withBoard({ ...changed, error: null }) };
      },
    },
    // Looks the tools up again for the notices' Recheck button and onboarding's detection.
    '/api/t3/reauthorize': {
      what: 'the T3 reauthorization request',
      async run() {
        if (sample || !reauthorizeT3) return { status: 403, body: { error: 'T3 reauthorization is unavailable here.' } };
        try {
          await reauthorizeT3();
          return { status: 200, body: withBoard({ error: null }) };
        } catch {
          return { status: 503, body: withBoard({ error: 'Could not reauthorize T3. Open T3 Code and try again.' }) };
        }
      },
    },
    '/api/recheck': {
      what: 'the recheck request',
      async run(input) {
        if (sample) return { status: 403, body: { error: 'Sample mode looks no tools up.' } };
        await recheck({ gh: input.gh === true, az: input.az === true });
        return { status: 200, body: withBoard({ error: null }) };
      },
    },
  };

  /** Opens a write: refuses it in sample mode, reads its body and checks its session. Answers and returns null on a problem. */
  async function writeInput(req: IncomingMessage, res: ServerResponse, write: Write): Promise<Record<string, unknown> | null> {
    if (sample && write.disabled) {
      json(res, 403, { error: write.disabled });
      return null;
    }
    const input = await readJson(req, res, write.what);
    if (input && write.restarted && input.session !== board.snapshot().capture?.session) {
      json(res, 409, write.restarted());
      return null;
    }
    return input;
  }

  /** Answers a guarded write and counts it as running until then. */
  async function guardedWrite(req: IncomingMessage, res: ServerResponse, write: Write): Promise<void> {
    runningWrites++;
    try {
      const input = await writeInput(req, res, write);
      if (!input) return;
      const { status, body } = await write.run(input);
      json(res, status, body);
    } finally {
      if (--runningWrites === 0) for (const resolve of drained.splice(0)) resolve();
    }
  }

  /** Refuses new guarded writes and answers once the running ones finish, so the app can stop the server. */
  async function drainRequest(res: ServerResponse): Promise<void> {
    draining = true;
    if (runningWrites > 0) await new Promise<void>((resolve) => drained.push(resolve));
    log('drained writes for an update');
    json(res, 200, {});
  }

  /**
   * Starts a read for status.sh and slice.sh, so a moved item reaches the board before its next timed read: of the
   * source listing the `url` it sends, else of everything.
   */
  async function readRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req, res, 'the read request');
    if (!body) return;
    if (sample) return json(res, 200, {});
    readSoon(typeof body.url === 'string' ? body.url : undefined);
    json(res, 202, {});
  }

  /** Lists T3's projects for onboarding's T3 project step, which reads gh for each repository's Repository config. */
  async function projectsRequest(res: ServerResponse): Promise<void> {
    if (sample) return json(res, 403, { error: 'Sample mode onboards no repository.' });
    try { json(res, 200, { projects: await projectChoices() }); }
    catch (err) { json(res, 502, { error: err instanceof Error ? err.message : String(err) }); }
  }

  /** Answers one item's details, which the item dialog reads when it opens. */
  async function itemDetailsRequest(url: URL, res: ServerResponse): Promise<void> {
    const itemId = url.searchParams.get('itemId');
    if (!itemId) return json(res, 400, { error: 'Name the item whose details to read.' });
    const item = board.snapshot().items.find((i) => i.id === itemId);
    if (!item) return json(res, 404, { error: 'That item is not on the board.' });
    try {
      const read = await itemDetails.details(item);
      if ('error' in read) json(res, read.status, { error: read.error });
      else json(res, 200, { details: read satisfies ItemDetails });
    } catch (err) { json(res, 502, { error: err instanceof Error ? err.message : String(err) }); }
  }

  /** Answers the next 10 older comments of one item, which the item dialog reads on "Load 10 more". */
  async function itemCommentsRequest(url: URL, res: ServerResponse): Promise<void> {
    const itemId = url.searchParams.get('itemId');
    if (!itemId) return json(res, 400, { error: 'Name the item whose comments to read.' });
    const before = url.searchParams.get('before');
    if (!before) return json(res, 400, { error: 'Name where the older comments start.' });
    const item = board.snapshot().items.find((i) => i.id === itemId);
    if (!item) return json(res, 404, { error: 'That item is not on the board.' });
    try {
      const read = await itemDetails.olderComments(item, before);
      if ('error' in read) json(res, read.status, { error: read.error });
      else json(res, 200, { page: read satisfies ItemCommentsPage });
    } catch (err) { json(res, 502, { error: err instanceof Error ? err.message : String(err) }); }
  }

  /** Answers the ticket picker's search of a repository's open tickets. */
  async function ticketsRequest(url: URL, res: ServerResponse): Promise<void> {
    if (sample) return json(res, 403, { error: 'Sample mode searches no tickets.' });
    const { status, body } = await capture.searchTickets({ repo: url.searchParams.get('repo'), query: url.searchParams.get('q') ?? '' });
    json(res, status, body);
  }

  /** Opens a page's event stream and sends the board data at once, so a reconnecting page catches up. */
  function openStream(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
    if (req.method === 'HEAD') return void res.end();
    const sendBoard = (data: object) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    streams.add(res);
    const unsubscribe = board.subscribe(sendBoard);
    res.on('close', () => {
      streams.delete(res);
      unsubscribe();
    });
    sendBoard(board.snapshot());
  }

  /** Only answer requests addressed to this machine, to block DNS rebinding. */
  function allowedHost(req: IncomingMessage): boolean {
    const host = (req.headers.host ?? '').toLowerCase();
    const { port } = server.address() as AddressInfo;
    return [`127.0.0.1:${port}`, `localhost:${port}`].includes(host);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!allowedHost(req)) return send(res, 421, 'text/plain; charset=utf-8', 'Misdirected request\n');
    const url = new URL(req.url ?? '/', 'http://localhost');
    const { pathname: path } = url;
    // The health check must answer at once; everything else runs tools or shows what the lookup found.
    if (path !== '/healthz' && !path.startsWith('/assets/')) await ready();
    if (req.method === 'POST' && req.headers.origin !== `http://${req.headers.host}`) {
      return json(res, 403, { error: 'Submit from this board page.' });
    }
    const write = req.method === 'POST' && Object.hasOwn(WRITES, path) ? WRITES[path] : undefined;
    if (write && appSecret && !hasAppSecret(req, appSecret)) {
      return json(res, 403, { error: 'Submit from the board app.' });
    }
    if (req.method === 'POST' && path === '/api/drain') {
      if (!appSecret || !hasAppSecret(req, appSecret)) return json(res, 403, { error: 'Only the board app can drain the board.' });
      return drainRequest(res);
    }
    if (write) {
      if (draining) return json(res, 503, { error: 'The board is installing an update. Try again once Lar Factory restarts.' });
      return guardedWrite(req, res, write);
    }
    if (req.method === 'POST' && path === '/api/read') return readRequest(req, res);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 405, 'text/plain; charset=utf-8', 'Method not allowed\n');
    }
    if (path === '/') {
      return send(res, 200, 'text/html; charset=utf-8', pageWithData(page.template, board.snapshot()));
    }
    if (path === '/api/events') return openStream(req, res);
    if (path === '/api/onboarding/projects') return projectsRequest(res);
    if (path === '/api/item-details') return itemDetailsRequest(url, res);
    if (path === '/api/item-comments') return itemCommentsRequest(url, res);
    if (path === '/api/publication/vocabulary') {
      if (sample) return json(res, 403, { error: 'Sample mode discovers no provider Vocabulary.' });
      const result = await publicationVocabulary(url.searchParams.get('repo'));
      return 'error' in result ? json(res, result.status, { error: result.error }) : json(res, 200, result);
    }
    if (path === '/api/tickets') return ticketsRequest(url, res);
    if (path === '/api/archive') return json(res, 200, { items: archive() });
    if (path === '/api/board') return send(res, 200, 'application/json; charset=utf-8', JSON.stringify(board.snapshot()));
    if (path === '/healthz') return json(res, 200, {});
    const asset = path.startsWith('/assets/') ? page.assets.get(path.slice('/assets/'.length)) : undefined;
    if (asset) return send(res, 200, asset.type, asset.body);
    send(res, 404, 'text/plain; charset=utf-8', 'Not found\n');
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      log(`request ${req.url} failed: ${err instanceof Error ? err.stack : String(err)}`);
      if (!res.headersSent) send(res, 500, 'text/plain; charset=utf-8', 'Internal error\n');
    });
  });

  return {
    server,
    endStreams() {
      for (const res of streams) res.end();
    },
  };
}
