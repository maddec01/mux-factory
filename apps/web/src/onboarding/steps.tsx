// The body of each onboarding step, which the dialog shows one at a time. The T3 project step lists T3's projects.
// What we found lists each detected fact, or Refused with why. Each question step shows where its default came from,
// then its options, each with one cost line and Refused where access blocks it, then the lines naming the choices it
// leaves for later. Connections lists the other onboarded repositories, ticking the ones it guesses from their roles. Work to import lists the tickets with a status label or tag, with what each one needs settled.
// Repository edits lists what the PR changes, with each file's contents, and asks for approval. Once Finish saves, the
// dialog says the repository is on the board, with the PR it opened.

import { type ReactNode } from 'react';
import { Clock, FileText, FolderPlus, GitPullRequest, LoaderCircle } from 'lucide-react';
import {
  REPOSITORY_OPERATIONS, SHARED_SETTINGS, STATUSES, isOnboarding, shownRepo, type FactoryFile, type ImportableTicket, type OnboardingChoices, type OnboardingPrChange,
  type ProjectChoice, type RepositoryItemSource, type SetupDetection, type SharedSetting, type Status,
} from '@lar-factory/shared';
import { Button } from '@lar-factory/ui/design-system/Button';
import { Alert } from '@lar-factory/ui/design-system/Alert';
import { Badge } from '@lar-factory/ui/design-system/Badge';
import { Checkbox } from '@lar-factory/ui/design-system/Checkbox';
import { Input } from '@lar-factory/ui/design-system/Input';
import { RadioGroup } from '@lar-factory/ui/design-system/RadioGroup';
import { NativeSelect } from '@lar-factory/ui/native-select';
import { useBoardStore } from '../board/board-store.ts';
import { kind } from '../buttons/button-kinds.tsx';
import { Choice, Field, Group } from './setup-fields.tsx';
import {
  answerProblem, answersOf, connectionOptions, connectionsOf, consentOptions, docsOptions, fileOptions, found, laterLines, operationTitle, originOf, skillOptions, sourceOptions,
  type Answers, type Option, type StepId,
} from './wizard-choices.ts';
import { type Creating, type Run, detectedOf, ticketProblem, unpickable, useWizardStore } from './wizard-store.ts';

/** Whether the project's repository shares defaults in .lar-factory.json, and whether they can be used. */
function ConfigBadge({ project }: { project: ProjectChoice }) {
  if (project.configProblem) return <Badge tone="warning">Unusable config</Badge>;
  return !!project.hasConfig && <Badge tone="info">Shared config</Badge>;
}

/** A problem with Retry, which reads T3's projects and their Repository configs again. */
function Problem({ title, children }: { title: string; children: ReactNode }) {
  const loadProjects = useWizardStore((s) => s.loadProjects);
  return (
    <Alert tone="danger" title={title} action={<Button {...kind('other')} onClick={() => void loadProjects()}>Retry</Button>}>{children}</Alert>
  );
}

/** What a step shows while T3's projects are read, or when they can't be; null once they are. */
function ProjectsPending() {
  const projects = useWizardStore((s) => s.projects);
  if (projects.state === 'loading') {
    return <p data-reading-projects className="m-0 flex items-center gap-2 text-sm text-base-700"><LoaderCircle className="size-4 animate-spin" /> Loading T3 Code projects...</p>;
  }
  if (projects.state === 'failed') return <Problem title="Could not load projects">{projects.error}</Problem>;
  return null;
}

/** Add a folder to T3 Code's folder, which Add runs `t3 project add` on; a failure shows t3's message and keeps the step. */
function NewProject({ creating }: { creating: Creating }) {
  const { setFolder, createProject } = useWizardStore();
  const add = () => void createProject();
  return (
    <div className="grid gap-3 rounded-lg border p-4">
      <Field label="Folder" hint="Enter the full path to the repository folder on this Mac.">
        {(described) => <span className="flex gap-2">
          <Input data-new-folder className="font-mono" placeholder="~/Developer/lar-web" value={creating.folder} disabled={creating.adding} {...described}
            onChange={(e) => setFolder(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') add(); }} />
          <Button {...kind('other')} data-add-project disabled={!creating.folder.trim()} loading={creating.adding}
            leftIcon={creating.adding ? undefined : <FolderPlus />} onClick={add}>{creating.adding ? 'Adding...' : 'Add to T3 Code'}</Button>
        </span>}
      </Field>
      {creating.error && <Alert tone="danger" title="Could not add the project">{creating.error}</Alert>}
    </div>
  );
}

function ProjectStep({ run }: { run: Run }) {
  const { projects, creating, pick, chooseNew } = useWizardStore();
  const onboarding = useBoardStore((s) => s.data.onboarding);
  if (projects.state !== 'loaded') return <ProjectsPending />;
  return (
    <Group legend="Repository folder">
      {projects.projects.length === 0 && <p className="m-0 text-sm text-base-700">Add a repository folder to T3 Code to begin.</p>}
      <RadioGroup value={run.projectId ?? (creating ? 'new' : '')} onValueChange={(id) => (id === 'new' ? chooseNew() : pick(id as string))} className="gap-2">
        {projects.projects.map((p) => {
          const reason = unpickable(p, run, { onboarding });
          const kept = p.onBoard && isOnboarding({ onboarding }, p.repo);
          return (
            <Choice key={p.id} value={p.id} disabled={!!reason} title={<span className="flex flex-wrap items-center gap-2">{p.name}
              {p.provider && <Badge>{p.provider}</Badge>}
              <ConfigBadge project={p} />
              {p.onBoard && <Badge>{kept ? 'onboarding' : 'on the board'}</Badge>}</span>}>
              <span className="font-mono">{p.folder}</span>{p.repo ? ` · ${shownRepo(p.repo)}` : ` · ${reason}`}{p.repo && kept && reason && ` · ${reason}`}{p.configProblem && <span className="block">Its .lar-factory.json can't be used, so every answer starts from detection.</span>}
            </Choice>
          );
        })}
        <Choice value="new" title="Add a folder to T3 Code">Use a repository already on this Mac.</Choice>
      </RadioGroup>
      {creating && <NewProject creating={creating} />}
    </Group>
  );
}

/** What a step shows while detection reads, or when it can't; null once it has. */
function DetectionPending() {
  const { detection, detect } = useWizardStore();
  if (!detection || detection.state === 'reading') {
    return <p data-detecting className="m-0 flex items-center gap-2 text-sm text-base-700"><LoaderCircle className="size-4 animate-spin" /> Reading the repository and your access...</p>;
  }
  if (detection.state === 'failed') {
    return <Alert tone="danger" title="Could not read the repository" action={<Button {...kind('other')} onClick={() => void detect()}>Retry</Button>}>{detection.error}</Alert>;
  }
  return null;
}

/** The lines naming the choices a step leaves for later. */
function Later({ step, detection }: { step: StepId; detection: SetupDetection }) {
  const lines = laterLines(step, detection);
  if (!lines.length) return null;
  return (
    <ul data-later className="m-0 grid list-none gap-1.5 border-t border-base-300 p-0 pt-3">
      {lines.map((line) => <li key={line} className="flex items-start gap-2 text-xs text-base-700"><Clock className="mt-px size-3.5 shrink-0" />{line}</li>)}
    </ul>
  );
}

const ORIGINS = { changed: ['Changed', 'accent'], shared: ['From Repository config', 'info'], detected: ['Detected', undefined] } as const;

const PRESELECTED = " The default is preselected. Change it if it's wrong.";

/** Where a question's answer came from, as a badge, with `unchanged`, the reminder that the default is preselected, until the user changes it. */
function OriginNote({ detection, choices, answer, unchanged = PRESELECTED }: { detection: SetupDetection; choices: OnboardingChoices; answer: keyof Answers; unchanged?: string }) {
  const origin = originOf(detection, choices, answer);
  const [title, tone] = ORIGINS[origin];
  return (
    <p data-origin className="m-0 flex items-center gap-2 text-xs text-base-700">
      <Badge tone={tone}>{title}</Badge>{origin !== 'changed' && unchanged}
    </p>
  );
}

/** An option's title with Refused or Unverified beside it. */
function OptionTitle<T>({ option }: { option: Option<T> }) {
  return (
    <span className="flex flex-wrap items-center gap-2">{option.title}
      {option.refused && <Badge tone="danger">Refused</Badge>}
      {option.unverified && <Badge>Unverified</Badge>}
    </span>
  );
}

/** A question's options as radio choices, a Refused one disabled. */
function OneOf<T>({ legend, options, value, onPick }: { legend: string; options: Option<T>[]; value: string; onPick: (value: T) => void }) {
  return (
    <Group legend={legend}>
      <RadioGroup value={value} onValueChange={(id) => onPick(options.find((o) => o.id === id)!.value)} className="gap-2">
        {options.map((o) => <Choice key={o.id} value={o.id} disabled={o.refused} title={<OptionTitle option={o} />}>{o.cost}</Choice>)}
      </RadioGroup>
    </Group>
  );
}

/** A question's options as tick boxes, a Refused one locked as `refusedTicked` says. */
function SomeOf<T>({ legend, options, ticked, refusedTicked = false, onTick }: {
  legend: string; options: Option<T>[]; ticked: (option: Option<T>) => boolean; refusedTicked?: boolean; onTick: (option: Option<T>, on: boolean) => void;
}) {
  return (
    <Group legend={legend}>
      <ul className="m-0 grid list-none gap-1.5 p-0">
        {options.map((o) => {
          const on = o.refused ? refusedTicked : ticked(o);
          return (
            <li key={o.id} data-option={o.id}>
              <label className={`flex items-start gap-2.5 rounded-lg border border-base-300 px-3 py-2 ${o.refused ? 'opacity-60' : 'cursor-pointer'}`}>
                <span className="pt-0.5"><Checkbox checked={on} disabled={o.refused} onChange={() => onTick(o, !on)} /></span>
                <span className="grid min-w-0 gap-0.5">
                  <span className="text-sm font-medium break-all"><OptionTitle option={o} /></span>
                  <span className="text-xs text-base-700">{o.cost}</span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    </Group>
  );
}

const sourceLine = (source: RepositoryItemSource, repo: string) => source.kind === 'azure-board' ? `${source.team}'s backlog and current sprint` : `${shownRepo(repo)}'s issues`;

/** The login's access as one line per kind: what it allows, refuses, and leaves unverified. */
function accessLine(detection: SetupDetection): string {
  const of = (access: string) => REPOSITORY_OPERATIONS.filter((op) => detection.access[op] === access).map((op) => operationTitle(op, detection).toLowerCase()).join(', ');
  return [['Allowed', of('allowed')], ['Refused', of('refused')], ['Unverified until needed', of('unverified')]]
    .flatMap(([title, ops]) => ops ? [`${title}: ${ops}.`] : []).join(' ');
}

/** Each shared setting as What we found names it. */
const SETTING_NAMES: Record<SharedSetting, string> = { role: 'role', itemSource: 'item source', labels: 'labels', domainDocs: 'domain-doc location', skills: 'skills', vocabulary: 'Vocabulary' };

/** Names in a sentence: `a`, `a and b`, `a, b and c`. */
const listed = (names: string[]) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]!);

const FILE_KINDS: Record<FactoryFile['kind'], string> = { config: '.lar-factory.json', 'agent-skills': '## Agent skills', 'agent-docs': 'docs/agents/' };

/** Each fact detection read, as a row: what it found, or Refused with why. */
function factRows(detection: SetupDetection): { label: string; fact: { found: ReactNode } | { refused: string } }[] {
  const shown = (fact: { found: unknown } | { refused: string }, show: () => ReactNode) => 'found' in fact ? { found: show() } : fact;
  const { checkout, itemSources, domainDocs, factoryFiles, sharedConfig, projectSkills } = detection;
  return [
    { label: 'Provider', fact: { found: detection.provider } },
    { label: 'Repository folder', fact: shown(checkout, () => <span className="font-mono">{found(checkout)}</span>) },
    { label: 'Item source', fact: shown(itemSources, () => found(itemSources)!.map((s) => sourceLine(s, detection.repo)).join(', ') || 'No teams found') },
    { label: 'Credential access', fact: { found: accessLine(detection) } },
    { label: 'Domain docs', fact: shown(domainDocs, () => { const docs = found(domainDocs)!; return docs.kind === 'repository' ? `${docs.glossary} and ${docs.adrs}/` : 'None found'; }) },
    { label: 'Factory files', fact: shown(factoryFiles, () => found(factoryFiles)!.map((f) => FILE_KINDS[f.kind]).join(', ') || 'None found') },
    { label: 'Repository config', fact: shown(sharedConfig, () => {
      const config = found(sharedConfig);
      if (!config) return 'None. Every setting is yours.';
      if ('problem' in config) return `.lar-factory.json can't be used: ${config.problem}`;
      const names = SHARED_SETTINGS.filter((key) => config.defaults[key] !== undefined).map((key) => SETTING_NAMES[key]);
      return names.length ? `.lar-factory.json supplies the ${listed(names)}. You can change each one here.` : '.lar-factory.json supplies no defaults.';
    }) },
    { label: 'Project skills', fact: shown(projectSkills, () => found(projectSkills)!.join(', ') || 'None found') },
  ];
}

/** What we found: each detected fact, or Refused with why, and the folder's refusal as a problem Next waits on. */
function DetectStep() {
  const detection = detectedOf(useWizardStore((s) => s.detection));
  const detect = useWizardStore((s) => s.detect);
  if (!detection) return <DetectionPending />;
  return (
    <div data-detect-step className="grid gap-4">
      <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-sm">
        {factRows(detection).map(({ label, fact }) => (
          <div key={label} data-fact={label} className="contents">
            <dt className="text-base-700">{label}</dt>
            <dd className="m-0 min-w-0 break-words">{'found' in fact ? fact.found : <span className="flex flex-wrap items-center gap-2"><Badge tone="danger">Refused</Badge>{fact.refused}</span>}</dd>
          </div>
        ))}
      </dl>
      {'refused' in detection.checkout && (
        <Alert tone="danger" title="Agents can't work in this folder" action={<Button {...kind('other')} onClick={() => void detect()}>Retry</Button>}>{detection.checkout.refused}</Alert>
      )}
      <Later step="detect" detection={detection} />
    </div>
  );
}

/** The step's detection and the run's answers, or what shows while detection reads. */
function useAnswers(run: Run): { detection: SetupDetection; answers: Answers } | null {
  const detection = detectedOf(useWizardStore((s) => s.detection));
  return detection && { detection, answers: answersOf(detection, run.choices) };
}

function SourceStep({ run }: { run: Run }) {
  const read = useAnswers(run);
  const choose = useWizardStore((s) => s.choose);
  if (!read) return <DetectionPending />;
  const { detection, answers } = read;
  const options = sourceOptions(detection);
  return (
    <div className="grid gap-4">
      <OriginNote detection={detection} choices={run.choices} answer="itemSource" />
      {options.length ? <OneOf legend="Team" options={options} value={options.find((o) => JSON.stringify(o.value) === JSON.stringify(answers.itemSource))?.id ?? ''}
        onPick={(itemSource) => choose({ itemSource })} />
        : <Alert tone="danger" title="No team to read">{'refused' in detection.itemSources ? detection.itemSources.refused : 'This project has no teams. Add a team in Azure DevOps, then go back and retry.'}</Alert>}
    </div>
  );
}

/** A ticket's Statuses as its labels or tags name them. */
const statusNames = (statuses: Status[]) => statuses.join(', ');

/** One ticket to import: its tick, reference and title, Status, and what it needs settled or why the import refused it. */
function TicketRow({ ticket, repo }: { ticket: ImportableTicket; repo: string }) {
  const { tickets, pickTicket } = useWizardStore();
  const pick = tickets?.picks[ticket.number];
  const refused = tickets?.refused[ticket.number];
  const problem = ticketProblem(ticket, pick);
  const ref = `#${ticket.number}`;
  if (ticket.workId) {
    return (
      <li data-ticket={ticket.number} className="flex items-baseline gap-2 px-3 py-2 text-sm">
        <span className="font-mono text-xs">{ref}</span><span className="min-w-0 flex-1 break-words">{ticket.title}</span><Badge tone="success">Recorded as {ticket.workId}</Badge>
      </li>
    );
  }
  return (
    <li data-ticket={ticket.number} className="grid gap-2 px-3 py-2 text-sm">
      <label className="flex items-baseline gap-2">
        <Checkbox checked={!!pick?.on} disabled={tickets?.importing} onChange={() => pickTicket(ticket.number, { on: !pick?.on })} />
        <span className="font-mono text-xs">{ref}</span><span className="min-w-0 flex-1 break-words">{ticket.title}</span>
        {ticket.statuses.length === 1 && <Badge>{ticket.statuses[0]}</Badge>}
      </label>
      {pick?.on && ticket.statuses.length > 1 && (
        <Field label="Status" hint={`It carries ${statusNames(ticket.statuses)}.`}>
          {(described) => <NativeSelect value={pick.status ?? ''} {...described} onChange={(e) => pickTicket(ticket.number, { status: e.target.value as Status })}>
            <option value="">Choose a Status</option>
            {STATUSES.filter((s) => ticket.statuses.includes(s)).map((s) => <option key={s} value={s}>{s}</option>)}
          </NativeSelect>}
        </Field>
      )}
      {pick?.on && ticket.untagged && (
        <label className="flex items-center gap-2 text-xs">
          <Checkbox checked={!!pick.placeHere} onChange={() => pickTicket(ticket.number, { placeHere: !pick.placeHere })} />
          It has no repo- tag. It is {shownRepo(repo)}'s work.
        </label>
      )}
      {(refused ?? problem) && <span data-problem className={`text-xs ${refused ? 'text-(--lar-danger-text)' : 'text-base-700'}`}>{refused ?? problem}</span>}
    </li>
  );
}

/** Work to import: each open ticket with a status label or tag, ticked to import with Next, and those recorded already. */
function ImportStep({ run }: { run: Run }) {
  const read = useAnswers(run);
  const { tickets, readTickets } = useWizardStore();
  if (!read) return <DetectionPending />;
  if (!tickets || tickets.read.state === 'reading') {
    return <p data-reading-tickets className="m-0 flex items-center gap-2 text-sm text-base-700"><LoaderCircle className="size-4 animate-spin" /> Reading open tickets...</p>;
  }
  if (tickets.read.state === 'failed') {
    return <Alert tone="danger" title="Could not read the tickets" action={<Button {...kind('other')} onClick={() => void readTickets()}>Retry</Button>}>
      {tickets.read.error} Next goes on without importing.</Alert>;
  }
  const list = tickets.read.value;
  return (
    <div data-import-step className="grid gap-3">
      {list.length ? <ul className="m-0 list-none divide-y rounded-lg border p-0">{list.map((t) => <TicketRow key={t.number} ticket={t} repo={run.repo!} />)}</ul>
        : <p className="m-0 text-sm text-base-700">No open ticket has a status {run.provider === 'Azure DevOps' ? 'tag' : 'label'}.</p>}
      {tickets.error && <Alert tone="danger" title="Could not import">{tickets.error}</Alert>}
    </div>
  );
}

function RoleStep({ run }: { run: Run }) {
  const read = useAnswers(run);
  const choose = useWizardStore((s) => s.choose);
  if (!read) return <DetectionPending />;
  const { detection, answers } = read;
  return (
    <div className="grid gap-4">
      <OriginNote detection={detection} choices={run.choices} answer="role" />
      <Field name="role" label="What this repository does" hint="Agents use it to place work. It grants and refuses nothing." problem={answerProblem('role', answers) ?? undefined}>
        {(described) => <Input placeholder="Web client that talks to the API server" value={answers.role} {...described} onChange={(e) => choose({ role: e.target.value })} />}
      </Field>
    </div>
  );
}

function ConnectionsStep({ run }: { run: Run & { repo: string } }) {
  const read = useAnswers(run);
  const choose = useWizardStore((s) => s.choose);
  const onboarded = useBoardStore((s) => s.data.repos);
  if (!read) return <DetectionPending />;
  const options = connectionOptions(run.repo, onboarded);
  if (!options.length) return <p className="m-0 text-sm text-base-700">No other repository is on the board yet, so there is nothing to connect.</p>;
  const ticked = connectionsOf(run.repo, read.answers.role, run.choices, onboarded);
  return (
    <div className="grid gap-4">
      <p data-origin className="m-0 flex items-center gap-2 text-xs text-base-700">
        {run.choices.connections ? <Badge tone="accent">Changed</Badge> : <><Badge>Guessed</Badge> Ticked from each repository's role and earlier Connections. Change it if it's wrong.</>}
      </p>
      <SomeOf legend="Related repositories" options={options} ticked={(o) => ticked.includes(o.value)}
        onTick={(o, on) => choose({ connections: on ? [...ticked, o.value] : ticked.filter((r) => r !== o.value) })} />
      <p className="m-0 text-xs text-base-700">Connections stay on this Mac. They grant no access: a build in a connected repository still waits for your OK.</p>
    </div>
  );
}

function ConsentStep({ run }: { run: Run }) {
  const read = useAnswers(run);
  const choose = useWizardStore((s) => s.choose);
  if (!read) return <DetectionPending />;
  const { detection, answers } = read;
  return (
    <div className="grid gap-4">
      <OriginNote detection={detection} choices={run.choices} answer="consent" />
      <SomeOf legend="Writes to allow" options={consentOptions(detection)} ticked={(o) => answers.consent.includes(o.value)}
        onTick={(o, on) => choose({ consent: on ? [...answers.consent, o.value] : answers.consent.filter((op) => op !== o.value) })} />
      <p className="m-0 text-xs text-base-700">Consent stays on this Mac, even where a Repository config is shared. Nothing was test-written.</p>
      <Later step="consent" detection={detection} />
    </div>
  );
}

function DocsStep({ run }: { run: Run }) {
  const read = useAnswers(run);
  const choose = useWizardStore((s) => s.choose);
  if (!read) return <DetectionPending />;
  const { detection, answers } = read;
  return (
    <div className="grid gap-4">
      <OriginNote detection={detection} choices={run.choices} answer="domainDocs" />
      <OneOf legend="Glossary and ADRs" options={docsOptions(detection)} value={answers.domainDocs.kind} onPick={(domainDocs) => choose({ domainDocs })} />
      <Later step="docs" detection={detection} />
    </div>
  );
}

function SkillsStep({ run }: { run: Run }) {
  const read = useAnswers(run);
  const choose = useWizardStore((s) => s.choose);
  if (!read) return <DetectionPending />;
  const { detection, answers } = read;
  const options = skillOptions(detection);
  return (
    <div className="grid gap-4">
      {'refused' in detection.projectSkills ? <p className="m-0 flex flex-wrap items-center gap-2 text-sm"><Badge tone="danger">Refused</Badge>{detection.projectSkills.refused}</p>
        : options.length ? <>
          <OriginNote detection={detection} choices={run.choices} answer="skills"
            unchanged={answers.skills.length ? PRESELECTED : ' Found in the repository. Tick the ones builds should follow.'} />
          <SomeOf legend="Coding guidance for builds" options={options} ticked={(o) => answers.skills.includes(o.value)}
            onTick={(o, on) => choose({ skills: on ? [...answers.skills, o.value] : answers.skills.filter((s) => s !== o.value) })} />
          <p className="m-0 text-xs text-base-700">Only ticked skills guide builds. A change applies to later builds.</p>
        </> : <p className="m-0 text-sm text-base-700">This repository has no project skills.</p>}
      <Later step="skills" detection={detection} />
    </div>
  );
}

function FilesStep({ run }: { run: Run }) {
  const read = useAnswers(run);
  const choose = useWizardStore((s) => s.choose);
  if (!read) return <DetectionPending />;
  const { detection, answers } = read;
  return (
    <div className="grid gap-4">
      <OriginNote detection={detection} choices={run.choices} answer="drop" />
      <SomeOf legend="Files to keep" options={fileOptions(detection)} refusedTicked ticked={(o) => !answers.drop.includes(o.value.kind)}
        onTick={(o, on) => choose({ drop: on ? answers.drop.filter((k) => k !== o.value.kind) : [...answers.drop, o.value.kind] })} />
      <p className="m-0 text-xs text-base-700">Untick a file to drop it. The next step shows the pull request that drops it, for your approval.</p>
    </div>
  );
}

/**
 * A path and what happens to it: side by side from `sm` up, the path kept whole; stacked below, where a long path
 * breaks anywhere rather than pushing the row wider.
 */
function PathAndWhat({ path, what }: { path: string; what: string }) {
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-2">
      <span className="font-mono text-xs break-all sm:shrink-0 sm:break-normal">{path}</span>
      <span className="min-w-0 text-xs text-base-700">{what}</span>
    </span>
  );
}

/** The PR's place from its URL: `owner/name#n` on GitHub, `organization/project/repository!n` on Azure Repos. */
function prName(url: string): string {
  const azure = /^https:\/\/dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+)\/pullrequest\/(\d+)$/.exec(url);
  if (!azure) return url.replace(/^https:\/\/github\.com\//, '').replace('/pull/', '#');
  const [, organization, project, repository, id] = azure;
  return `${shownRepo(`${organization}/${project}/${repository}`)}!${id}`;
}

/** A change of the PR as its list shows it: the path, then what the PR does to it. */
function changeRow(change: OnboardingPrChange): { path: string; what: string } {
  if (change.kind === 'agent-skills') return { path: change.path, what: change.removed ? 'Removes the ## Agent skills block.' : 'Writes the ## Agent skills block.' };
  if (change.kind === 'write') return { path: change.path, what: change.created ? 'Adds the file.' : 'Replaces the file.' };
  if (change.kind === 'edit') return { path: change.path, what: `Edits line ${change.line}: ${change.reason}` };
  if (change.kind === 'delete') return { path: change.path, what: 'Deletes it.' };
  return { path: change.path, what: `Renames it to ${change.to}` };
}

/** Repository edits: what the PR changes against the default branch, with each file's contents, and the approval Finish waits for. */
function EditsStep() {
  const { changes, approved, previewEdits, approve } = useWizardStore();
  if (!changes || changes.state === 'reading') {
    return <p data-reading-changes className="m-0 flex items-center gap-2 text-sm text-base-700"><LoaderCircle className="size-4 animate-spin" /> Loading changes...</p>;
  }
  if (changes.state === 'failed') {
    return <Alert tone="danger" title="Could not load changes" action={<Button {...kind('other')} onClick={() => void previewEdits()}>Retry</Button>}>{changes.error}</Alert>;
  }
  return (
    <div data-edits-step className="grid gap-3">
      <ul data-pr-changes className="m-0 grid list-none gap-1 rounded-lg border p-3 text-sm">
        {changes.value.map((change, i) => {
          const row = changeRow(change);
          return (
            <li key={i} data-change={row.path} className="flex items-start gap-2"><FileText className="mt-0.5 size-3.5 shrink-0 text-base-700" />
              <div className="min-w-0 flex-1">
                <PathAndWhat path={row.path} what={row.what} />
                {change.preview && <details className="mt-2">
                  <summary className="cursor-pointer text-xs text-base-700">View contents</summary>
                  <div className="mt-2 grid gap-2">
                    {change.preview.before === null ? <p className="m-0 text-xs text-base-700">New file</p> : <>
                      <p className="m-0 text-xs font-medium">Current contents</p>
                      <pre className="m-0 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-base-200 p-3 font-mono text-xs">{change.preview.before}</pre>
                    </>}
                    <p className="m-0 text-xs font-medium">Proposed contents</p>
                    <pre className="m-0 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-base-200 p-3 font-mono text-xs">{change.preview.after}</pre>
                  </div>
                </details>}
              </div></li>
          );
        })}
      </ul>
      <label data-approve className="flex items-center gap-2 text-sm">
        <Checkbox checked={approved} onChange={() => approve(!approved)} />
        Open a pull request with these edits when I finish
      </label>
      <p className="m-0 text-xs text-base-700">Your local files stay as they are. To change nothing, go back and keep every file.</p>
    </div>
  );
}

/** Once Finish saved: the repository is on the board, with the PR it opened, or why it couldn't with Retry. */
function DoneBody({ run }: { run: Run }) {
  const { finish, openPr } = useWizardStore();
  const repo = shownRepo(run.repo ?? '');
  const pr = finish.state === 'done' ? finish.pr : null;
  return (
    <div data-done className="grid gap-3">
      <Alert tone="success" title={`${repo} is on the board`}>Its settings are saved on this Mac. Nothing was written to the repository.</Alert>
      {pr?.state === 'opening' && <p className="m-0 flex items-center gap-2 text-sm text-base-700"><LoaderCircle className="size-4 animate-spin" /> Opening the pull request...</p>}
      {pr?.state === 'opened' && <p data-pr-opened className="m-0 flex items-center gap-2 text-sm"><GitPullRequest className="size-4 shrink-0" />
        <span><a className="font-medium underline" href={pr.url} target="_blank" rel="noreferrer">{prName(pr.url)}</a> holds the edits you approved, ready for review.</span></p>}
      {pr?.state === 'failed' && <Alert tone="danger" title="Could not open the pull request" action={<Button {...kind('other')} onClick={() => void openPr()}>Retry</Button>}>{pr.error}</Alert>}
    </div>
  );
}

/** The step's body, with why Finish couldn't save above it; once Finish saved, what it did. */
export function StepBody({ run }: { run: Run }) {
  const finish = useWizardStore((s) => s.finish);
  if (finish.state === 'done') return <DoneBody run={run} />;
  return (
    <div className="grid gap-4">
      {finish.state === 'failed' && <Alert tone="danger" title="Could not save the setup">{finish.error}</Alert>}
      <Step run={run} />
    </div>
  );
}

function Step({ run }: { run: Run }) {
  switch (run.step) {
    case 'project': return <ProjectStep run={run} />;
    case 'detect': return <DetectStep />;
    case 'source': return <SourceStep run={run} />;
    case 'import': return <ImportStep run={run} />;
    case 'role': return <RoleStep run={run} />;
    case 'connections': return run.repo ? <ConnectionsStep run={{ ...run, repo: run.repo }} /> : null;
    case 'consent': return <ConsentStep run={run} />;
    case 'docs': return <DocsStep run={run} />;
    case 'skills': return <SkillsStep run={run} />;
    case 'files': return <FilesStep run={run} />;
    case 'edits': return <EditsStep />;
  }
}
