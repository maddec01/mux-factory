// The onboarding run the dialog shows: its step, the T3 project it picked and the choices it changed from the detected
// defaults, with T3's projects as the server lists them and the folder Create a new T3 project adds. Closing before a
// project is picked, or an offered run before Next or any change, drops the run; closing after keeps its repository on
// this Mac's list as onboarding, with where it stopped, and Resume reopens it there. What we found detects the
// repository's setup, reading only, and holds Next until it can use the T3 project's folder. Work to import lists the
// open tickets with a status label or tag, and Next imports the ticked ones, staying on the step while one needs the
// user to settle its Status or placement. Repository edits previews the PR that drops the factory files the user
// unticked, and Finish waits for the user's approval of it. Finish saves the answers as local settings, with the
// Connections ticked, which puts the repository on the board, then opens the approved PR.

import { create } from 'zustand';
import {
  isOnboarding, sameRepo, type BoardData, type ImportableTicket, type OnboardingChoices, type OnboardingOffer, type OnboardingPrChange,
  type OnboardingProgress, type ProjectChoice, type Provider, type SetupDetection, type Status, type TicketImport, type TicketsImported,
} from '@lar-factory/shared';
import { useBoardStore } from '../board/board-store.ts';
import { postAction, receive } from '../items/card-actions.ts';
import { showToast } from '../notices/toasts.tsx';
import { STEP_TITLES, answerProblem, answersOf, connectionsOf, isStep, stepsOf, type StepId } from './wizard-choices.ts';

/** Where a kept onboarding stopped, as a phrase; a step this dialog doesn't have, as an older board's, reads as the first. */
export const stoppedAt = ({ step }: OnboardingProgress): string => `stopped at ${STEP_TITLES[isStep(step) ? step : 'project']}`;

export interface Run {
  step: StepId;
  /** The picked T3 project's id. */
  projectId: string | null;
  /** The picked T3 project's repository. */
  repo: string | null;
  /** The picked T3 project's provider, from its origin's host; null until one is picked. */
  provider: Provider | null;
  /** The repository the run was kept under when it was last closed; null for a run never kept. */
  savedAs: string | null;
  choices: OnboardingChoices;
}

export type Projects = { state: 'loading' } | { state: 'loaded'; projects: ProjectChoice[] } | { state: 'failed'; error: string };

/** Create a new T3 project, while it's the T3 project step's choice: the folder to add, and how adding it went. */
export interface Creating {
  folder: string;
  adding: boolean;
  error: string | null;
}

/** A read the board answers: running, answered, or the board's problem. */
export type Read<T> = { state: 'reading' } | { state: 'read'; value: T } | { state: 'failed'; error: string };

/** The user's pick for a ticket to import: whether it's ticked, and the Status or placement it needs. */
export interface TicketPick {
  on: boolean;
  status?: Status;
  placeHere?: boolean;
}

/** Work to import: the tickets offered, the user's picks, and the last import's refusals by ticket, or its problem. */
export interface Tickets {
  read: Read<ImportableTicket[]>;
  picks: Record<number, TicketPick>;
  importing: boolean;
  refused: Record<number, string>;
  error: string | null;
}

/** Finish: saving the answers, then opening the approved PR, if any, or the problem with either. */
type Finish = { state: 'idle' } | { state: 'saving' } | { state: 'failed'; error: string }
  | { state: 'done'; pr: null | { state: 'opening' } | { state: 'opened'; url: string } | { state: 'failed'; error: string } };

/**
 * Why a T3 project can't be picked, or null when it can. The repository a resumed run was kept under stays pickable;
 * another one still onboarding is resumed from its own Resume.
 */
export function unpickable(project: ProjectChoice, run: Run, data: Pick<BoardData, 'onboarding'> = useBoardStore.getState().data): string | null {
  if (project.onBoard && !(project.repo && run.savedAs && sameRepo(project.repo, run.savedAs))) {
    return isOnboarding(data, project.repo) ? 'Setup is already in progress. Close this window and choose Resume.' : 'This repository is already on the board.';
  }
  if (!project.repo) return 'Choose a repository folder connected to GitHub or Azure DevOps.';
  return null;
}

/** The run's picked project, from T3's projects. */
export function pickedProject(run: Run, projects: Projects): ProjectChoice | null {
  return projects.state === 'loaded' ? projects.projects.find((p) => p.id === run.projectId) ?? null : null;
}

/** The run's detection, once read. */
export const detectedOf = (detection: Read<SetupDetection> | null): SetupDetection | null => (detection?.state === 'read' ? detection.value : null);

/** The steps the run shows, as its detection shapes them. */
export const runSteps = (run: Run, detection: Read<SetupDetection> | null): StepId[] => stepsOf(run.provider, detectedOf(detection), run.choices);

/** Whether a ticket is offered for import: open, with a status, and held by no work record yet. */
const importable = (ticket: ImportableTicket) => ticket.workId === null;

/** What a ticked ticket needs before it can import, or null: its Status among several, or confirming an untagged work item is this repository's. */
export function ticketProblem(ticket: ImportableTicket, pick: TicketPick | undefined): string | null {
  if (!pick?.on) return null;
  if (ticket.statuses.length > 1 && !pick.status) return 'Choose its Status, or untick it.';
  if (ticket.untagged && !pick.placeHere) return "Confirm it is this repository's work, or untick it.";
  return null;
}

/** The ticked tickets to import, with the Status or placement each needs. */
function toImport(tickets: Tickets): TicketImport[] {
  if (tickets.read.state !== 'read') return [];
  return tickets.read.value.filter((t) => importable(t) && tickets.picks[t.number]?.on).map((t) => {
    const { status, placeHere } = tickets.picks[t.number]!;
    return { number: t.number, ...t.statuses.length > 1 && status && { status }, ...t.untagged && placeHere && { placeHere } };
  });
}

/** Whether the run's step lets Next or Finish move past it. */
export function stepReady(run: Run, projects: Projects, detection: Read<SetupDetection> | null, tickets: Tickets | null = null,
  changes: Read<OnboardingPrChange[]> | null = null, approved = false): boolean {
  if (!pickedProject(run, projects)) return false;
  if (run.step === 'project') return true;
  const detected = detectedOf(detection);
  if (!detected || !('found' in detected.checkout)) return false;
  if (answerProblem(run.step, answersOf(detected, run.choices))) return false;
  if (run.step === 'import') {
    if (!tickets || tickets.importing || tickets.read.state === 'reading') return false;
    return tickets.read.state === 'failed' || tickets.read.value.every((t) => !importable(t) || !ticketProblem(t, tickets.picks[t.number]));
  }
  if (run.step === 'edits') return changes?.state === 'read' && approved;
  return true;
}

interface WizardState {
  /** The run the dialog shows; null while it's closed. */
  run: Run | null;
  projects: Projects;
  /** Create a new T3 project's form; null while a listed project is the choice. */
  creating: Creating | null;
  /** What we found; null until the run first reaches it. */
  detection: Read<SetupDetection> | null;
  /** Work to import; null until the run first reaches it. */
  tickets: Tickets | null;
  /** Repository edits' PR changes, as the board previews them; null until the run reaches the step. */
  changes: Read<OnboardingPrChange[]> | null;
  /** Whether the user approved the previewed edits. */
  approved: boolean;
  finish: Finish;
  /** The button that opened the dialog, which gets focus back when it closes. */
  opener: HTMLElement | null;
  /** Opens a new run, with the offered T3 project picked when it comes from an offer. */
  start: (offer?: OnboardingOffer) => void;
  /** Reopens the onboarding the board keeps for `repo`, on its step with its choices. */
  resume: (repo: string) => void;
  close: () => void;
  /** Reads T3's projects again. */
  loadProjects: () => Promise<void>;
  /** Picks a T3 project; another one than before drops what the run detected and chose. */
  pick: (projectId: string) => void;
  /** Chooses Create a new T3 project, which unpicks the picked project. */
  chooseNew: () => void;
  setFolder: (folder: string) => void;
  /** Adds the form's folder as a T3 project and picks it. */
  createProject: () => Promise<void>;
  /** Detects the picked repository's setup again. */
  detect: () => Promise<void>;
  /** Changes the run's choices; a new item source reads the tickets again, and new drops preview the edits again. */
  choose: (change: OnboardingChoices) => void;
  /** Reads the tickets to import with the run's item source. */
  readTickets: () => Promise<void>;
  /** Ticks or unticks a ticket to import, or settles its Status or placement. */
  pickTicket: (number: number, change: Partial<TicketPick>) => void;
  /** Next: on Work to import, imports the ticked tickets first and stays while one is refused. */
  next: () => Promise<void>;
  back: () => void;
  /** Asks the board what the PR that drops the unticked factory files changes. */
  previewEdits: () => Promise<void>;
  approve: (approved: boolean) => void;
  /** Saves the answers, which puts the repository on the board, then opens the approved PR. */
  save: () => Promise<void>;
  /** Opens the approved PR, again after a failure. */
  openPr: () => Promise<void>;
}

/** Counts project reads, so one answered after a newer read or a close is dropped. */
let reads = 0;
/** Counts the run's other reads, so one answered after a newer one, another project or a close is dropped. */
let detections = 0;
let ticketReads = 0;
let previews = 0;
/** The run an offer opened, until Next or a change replaces it; closing it then keeps nothing. */
let untouchedOffer: Run | null = null;

/** The focused element, as the button that opens the dialog; null when nothing is. */
const focused = (): HTMLElement | null => document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;

/** The run a kept onboarding resumes; a step this dialog doesn't have, as an older board's, resumes on the T3 project step. */
const resumed = (repo: string, progress: OnboardingProgress): Run => ({ step: isStep(progress.step) ? progress.step : 'project',
  projectId: progress.answers.projectId, repo, provider: progress.answers.provider ?? null, savedAs: repo, choices: progress.answers.choices ?? {} });

/** Where the run stopped, as the board keeps it, with the steps before it as done. */
function progressOf(run: Run & { projectId: string }, detection: Read<SetupDetection> | null): OnboardingProgress {
  const steps = runSteps(run, detection);
  return { step: run.step, done: steps.slice(0, Math.max(0, steps.indexOf(run.step))),
    answers: { projectId: run.projectId, ...run.provider && { provider: run.provider }, ...Object.keys(run.choices).length && { choices: run.choices } } };
}

/** The onboarding a run kept under another repository replaces, to send with its repository. */
const replacing = (run: Run & { repo: string }) => run.savedAs && !sameRepo(run.savedAs, run.repo) ? { replaces: run.savedAs } : {};

/** Asks the server to keep the run's repository as onboarding; a refusal shows in a toast. */
async function keep(run: Run & { projectId: string; repo: string }, detection: Read<SetupDetection> | null): Promise<void> {
  const result = await postAction('/api/onboarding/repositories', { repo: run.repo, progress: progressOf(run, detection), ...replacing(run) });
  receive(result);
  if (result.error) showToast({ slot: 'onboarding', failed: true, what: ` error for onboarding ${run.repo}`,
    body: `Couldn't keep onboarding ${run.repo} on the board. ${result.error}` });
}

const FRESH = { detection: null, tickets: null, changes: null, approved: false, finish: { state: 'idle' } } as const;

export const useWizardStore = create<WizardState>()((set, get) => {
  /** Drops every read the run is waiting for. */
  const forget = () => { detections++; ticketReads++; previews++; };

  /** Reads what a step shows when the run reaches it, unless it has it already. */
  const enter = (step: StepId) => {
    const { detection, tickets } = get();
    if (step !== 'project' && !detection) void get().detect();
    if (step === 'import' && !tickets) void get().readTickets();
    if (step === 'edits') void get().previewEdits();
  };

  const move = (by: 1 | -1) => {
    const { run, detection } = get();
    if (!run) return;
    const steps = runSteps(run, detection);
    const to = steps[steps.indexOf(run.step) + by];
    if (!to) return;
    set({ run: { ...run, step: to } });
    enter(to);
  };

  /** Imports the ticked tickets; whether every one imported. */
  const importTickets = async (): Promise<boolean> => {
    const { run, tickets, detection } = get();
    const detected = detectedOf(detection);
    const chosen = tickets ? toImport(tickets) : [];
    if (!run?.repo || !tickets || !detected || !chosen.length) return true;
    const read = ++ticketReads;
    set({ tickets: { ...tickets, importing: true, error: null } });
    const answer = await postAction<TicketsImported>('/api/onboarding/import', { repo: run.repo, itemSource: answersOf(detected, run.choices).itemSource, tickets: chosen });
    receive(answer);
    const now = get().tickets;
    if (read !== ticketReads || !now) return false;
    if (answer.error || !answer.refused) {
      set({ tickets: { ...now, importing: false, error: answer.error ?? 'The board sent no import.' } });
      return false;
    }
    set({ tickets: { ...now, importing: false, refused: Object.fromEntries(answer.refused.map((r) => [r.number, r.reason])) } });
    // The tickets imported now have records, so the list shows them as recorded.
    await get().readTickets();
    return answer.refused.length === 0;
  };

  return {
    run: null,
    projects: { state: 'loading' },
    creating: null,
    ...FRESH,
    opener: null,
    start: (offer) => {
      forget();
      const run: Run = { step: 'project', projectId: offer?.projectId ?? null, repo: offer?.repo ?? null, provider: offer?.provider ?? null, savedAs: null, choices: {} };
      untouchedOffer = offer ? run : null;
      set({ run, creating: null, ...FRESH, opener: focused() });
      void get().loadProjects();
    },
    resume: (repo) => {
      const kept = useBoardStore.getState().data.onboarding?.find((o) => sameRepo(o.repo, repo));
      if (!kept) return;
      forget();
      const run = resumed(kept.repo, kept.progress);
      set({ run, creating: null, ...FRESH, opener: focused() });
      void get().loadProjects();
      if (run.step !== 'project') void get().detect().then(() => { const now = get().run; if (now) enter(now.step); });
    },
    close: () => {
      const { run, detection, finish } = get();
      reads++;
      forget();
      set({ run: null, ...FRESH });
      // A run Finish saved is on the board, so there's no onboarding left to keep.
      if (run?.projectId && run.repo && run !== untouchedOffer && finish.state !== 'done') keep({ ...run, projectId: run.projectId, repo: run.repo }, detection);
    },
    loadProjects: async () => {
      const read = ++reads;
      set({ projects: { state: 'loading' } });
      let projects: Projects;
      try {
        const response = await fetch('/api/onboarding/projects', { cache: 'no-store' });
        const body = await response.json() as { projects?: ProjectChoice[]; error?: string };
        projects = body.projects ? { state: 'loaded', projects: body.projects } : { state: 'failed', error: body.error ?? `The board answered ${response.status}.` };
      } catch {
        projects = { state: 'failed', error: "Can't reach the board." };
      }
      if (read === reads) set({ projects });
    },
    pick: (projectId) => {
      const { run, projects } = get();
      const project = projects.state === 'loaded' ? projects.projects.find((p) => p.id === projectId) : undefined;
      if (!run || !project || unpickable(project, run)) return;
      const same = run.projectId === projectId;
      if (!same) forget();
      set({ run: { ...run, projectId, repo: project.repo, provider: project.provider, choices: same ? run.choices : {} }, creating: null, ...!same && FRESH });
    },
    chooseNew: () => {
      const { run, creating } = get();
      if (!run) return;
      forget();
      set({ run: { ...run, projectId: null, repo: null, provider: null, choices: {} }, creating: creating ?? { folder: '', adding: false, error: null }, ...FRESH });
    },
    setFolder: (folder) => {
      const { creating } = get();
      if (creating) set({ creating: { ...creating, folder } });
    },
    createProject: async () => {
      const { creating } = get();
      if (!creating || creating.adding) return;
      set({ creating: { ...creating, adding: true, error: null } });
      const result = await postAction<{ projects: ProjectChoice[]; projectId: string }>('/api/onboarding/projects', { folder: creating.folder });
      const { run, creating: now } = get();
      // The run closed, or the step chose a listed project, while t3 ran.
      if (!run || !now) return;
      if (result.error || !result.projects || !result.projectId) return set({ creating: { ...now, adding: false, error: result.error ?? 'The board sent no project.' } });
      reads++;
      set({ projects: { state: 'loaded', projects: result.projects } });
      const added = result.projects.find((p) => p.id === result.projectId);
      const reason = added ? unpickable(added, run) : 'T3 Code doesn\'t list it.';
      if (reason) return set({ creating: { ...now, adding: false, error: `T3 Code added the project, but it can't be picked: ${reason}` } });
      get().pick(result.projectId);
    },
    detect: async () => {
      const { run } = get();
      if (!run?.repo || !run.projectId) return;
      const read = ++detections;
      set({ detection: { state: 'reading' } });
      const answer = await postAction<{ detection: SetupDetection }>('/api/onboarding/detect', { repo: run.repo, projectId: run.projectId });
      if (read !== detections || !get().run) return;
      set({ detection: answer.detection ? { state: 'read', value: answer.detection } : { state: 'failed', error: answer.error ?? 'The board sent no detection.' } });
    },
    choose: (change) => {
      const { run, tickets } = get();
      if (!run) return;
      const sourceChanged = change.itemSource && JSON.stringify(change.itemSource) !== JSON.stringify(run.choices.itemSource);
      if (sourceChanged) ticketReads++;
      if (change.drop) previews++;
      set({ run: { ...run, choices: { ...run.choices, ...change } }, tickets: sourceChanged ? null : tickets,
        ...change.drop && { changes: null, approved: false } });
    },
    readTickets: async () => {
      const { run, detection, tickets } = get();
      const detected = detectedOf(detection);
      const itemSource = detected && answersOf(detected, run?.choices ?? {}).itemSource;
      if (!run?.repo || !detected) return;
      const read = ++ticketReads;
      if (!itemSource) return set({ tickets: { picks: {}, refused: {}, error: null, importing: false, read: { state: 'failed', error: 'Go back and choose a team first.' } } });
      set({ tickets: { picks: {}, refused: {}, error: null, ...tickets, importing: false, read: { state: 'reading' } } });
      const answer = await postAction<{ tickets: ImportableTicket[] }>('/api/onboarding/import/tickets', { repo: run.repo, itemSource });
      const now = get().tickets;
      if (read !== ticketReads || !now || !get().run) return;
      if (!answer.tickets) return set({ tickets: { ...now, read: { state: 'failed', error: answer.error ?? 'The board sent no tickets.' } } });
      // Each ticket offered for the first time starts ticked; one the user unticked stays so.
      const picks = Object.fromEntries(answer.tickets.filter(importable).map((t) => [t.number, now.picks[t.number] ?? { on: true }]));
      set({ tickets: { ...now, read: { state: 'read', value: answer.tickets }, picks } });
    },
    pickTicket: (number, change) => {
      const { tickets } = get();
      if (!tickets) return;
      const { [number]: _, ...refused } = tickets.refused;
      set({ tickets: { ...tickets, picks: { ...tickets.picks, [number]: { on: false, ...tickets.picks[number], ...change } }, refused } });
    },
    next: async () => {
      const { run, projects, detection, tickets, changes, approved } = get();
      if (!run || !stepReady(run, projects, detection, tickets, changes, approved)) return;
      if (run.step === 'import' && !await importTickets()) return;
      if (get().run?.step === run.step) move(1);
    },
    back: () => move(-1),
    previewEdits: async () => {
      const { run, detection } = get();
      const detected = detectedOf(detection);
      if (!run?.repo || !detected) return;
      const read = ++previews;
      set({ changes: { state: 'reading' }, approved: false });
      const answer = await postAction<{ changes: OnboardingPrChange[] }>('/api/onboarding/pr/changes', { repo: run.repo, edits: { drop: answersOf(detected, run.choices).drop } });
      if (read !== previews || !get().run) return;
      set({ changes: answer.changes ? { state: 'read', value: answer.changes } : { state: 'failed', error: answer.error ?? 'The board sent no changes.' } });
    },
    approve: (approved) => set({ approved }),
    save: async () => {
      const { run, projects, detection, tickets, changes, approved, finish } = get();
      const detected = detectedOf(detection);
      const steps = run && runSteps(run, detection);
      if (!run?.repo || !run.projectId || !detected || finish.state === 'saving' || finish.state === 'done' || run.step !== steps?.at(-1)
        || !stepReady(run, projects, detection, tickets, changes, approved)) return;
      const { drop, ...answers } = answersOf(detected, run.choices);
      set({ finish: { state: 'saving' } });
      const connections = connectionsOf(run.repo, answers.role, run.choices, useBoardStore.getState().data.repos);
      const result = await postAction('/api/onboarding/setup', { repo: run.repo, projectId: run.projectId, ...answers, connections, ...replacing({ ...run, repo: run.repo }) });
      receive(result);
      if (get().run !== run) return;
      if (result.error) return set({ finish: { state: 'failed', error: result.error } });
      set({ finish: { state: 'done', pr: null } });
      if (drop.length && approved) await get().openPr();
    },
    openPr: async () => {
      const { run, detection, finish } = get();
      const detected = detectedOf(detection);
      if (!run?.repo || !detected || finish.state !== 'done' || finish.pr?.state === 'opening' || finish.pr?.state === 'opened') return;
      set({ finish: { state: 'done', pr: { state: 'opening' } } });
      const result = await postAction<{ prUrl: string }>('/api/onboarding/pr', { repo: run.repo, edits: { drop: answersOf(detected, run.choices).drop } });
      if (get().run !== run) return;
      set({ finish: { state: 'done', pr: result.prUrl ? { state: 'opened', url: result.prUrl } : { state: 'failed', error: result.error ?? 'The board sent no PR.' } } });
    },
  };
});
