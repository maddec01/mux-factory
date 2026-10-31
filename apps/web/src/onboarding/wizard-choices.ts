// The onboarding wizard's questions as detection shapes them: the steps a run shows, in order, each answer's detected
// default and where it came from, each option with its one cost line and Refused where the login's access blocks it,
// and the lines a step says about the choices it leaves for later. A shared .lar-factory.json's defaults come first,
// then what detection found; the user's choices replace either.

import {
  OFFERED_OPERATIONS, sameRepo, shownRepo, type Detected, type DomainDocLocation, type FactoryFile, type FactoryFileKind, type OnboardingChoices,
  type Provider, type RepoConfig, type RepositoryItemSource, type RepositoryOperation, type SetupDetection, type SharedRepositorySettings,
} from '@lar-factory/shared';

/** Every step by id, in order, with its title. */
export const STEP_TITLES = {
  project: 'Repository', detect: 'What we found', source: 'Item source', import: 'Work to import', role: 'Repository role', connections: 'Connections',
  consent: 'Write consent', docs: 'Domain docs', skills: 'Project skills', files: 'Factory files', edits: 'Repository edits',
} as const;
export type StepId = keyof typeof STEP_TITLES;

export const isStep = (id: string): id is StepId => Object.hasOwn(STEP_TITLES, id);

/** The fact detection found, or null when the login's access refused it. */
export const found = <T>(fact: Detected<T>): T | null => ('found' in fact ? fact.found : null);

/**
 * The steps a run shows, in order. An Azure DevOps repository picks its team's item source; Factory files shows only
 * for a repository with files from an earlier setup, and Repository edits only once one of them is dropped.
 */
export function stepsOf(provider: Provider | null, detection: SetupDetection | null, choices: OnboardingChoices): StepId[] {
  const files = !!detection && !!found(detection.factoryFiles)?.length;
  return ['project', 'detect', ...provider === 'Azure DevOps' ? ['source' as const] : [], 'import', 'role', 'connections', 'consent', 'docs', 'skills',
    ...files ? ['files' as const] : [], ...files && choices.drop?.length ? ['edits' as const] : []];
}

/** The answers onboarding saves, with the factory files to drop. */
export interface Answers {
  /** Null while an Azure DevOps repository has no team to read. */
  itemSource: RepositoryItemSource | null;
  role: string;
  consent: RepositoryOperation[];
  domainDocs: DomainDocLocation;
  skills: string[];
  drop: FactoryFileKind[];
}

/** One option of a question: what it sets, its title, its one cost line, and whether access refuses it or is unverified. */
export interface Option<T> {
  id: string;
  value: T;
  title: string;
  cost: string;
  refused?: boolean;
  unverified?: boolean;
}

/** The shared .lar-factory.json's defaults; none when the repository has none or they can't be used. */
function sharedOf(detection: SetupDetection): SharedRepositorySettings {
  const config = found(detection.sharedConfig);
  return config && 'defaults' in config ? config.defaults : {};
}

const sourceId = (source: RepositoryItemSource) => (source.kind === 'azure-board' ? `team:${source.team}` : 'issues');

/** The item sources to pick from: each Azure DevOps team found, with the shared default's team when it isn't one. */
export function sourceOptions(detection: SetupDetection): Option<RepositoryItemSource>[] {
  if (detection.provider === 'GitHub') return [{ id: 'issues', value: { kind: 'issues' }, title: `${shownRepo(detection.repo)}'s issues`, cost: 'Open issues appear on the board.' }];
  const shared = sharedOf(detection).itemSource;
  const sources = [...found(detection.itemSources) ?? []];
  if (shared && !sources.some((s) => sourceId(s) === sourceId(shared))) sources.unshift(shared);
  return sources.map((source) => ({ id: sourceId(source), value: source, title: source.kind === 'azure-board' ? source.team : 'Issues',
    cost: "The team's backlog and current sprint appear on the board." }));
}

/** Whether the login may open the PR a repository edit needs: neither pushing a branch nor opening a PR is refused. */
const prRefused = (detection: SetupDetection) => detection.access['push-branch'] === 'refused' || detection.access['open-pr'] === 'refused';

const NEW_DOCS: DomainDocLocation = { kind: 'repository', glossary: 'GLOSSARY.md', adrs: 'docs/adr' };

/** Where domain docs go: the repository's own, or new ones a build PR adds, or private drafts on this Mac. */
export function docsOptions(detection: SetupDetection): Option<DomainDocLocation>[] {
  const shared = sharedOf(detection).domainDocs;
  const existing = [shared, found(detection.domainDocs)].find((docs) => docs?.kind === 'repository');
  const where = existing ?? NEW_DOCS;
  const paths = where.kind === 'repository' ? `${where.glossary} and ${where.adrs}/` : '';
  const refusal = 'refused' in detection.domainDocs ? "Refused: the repository's files can't be read."
    : detection.access['open-pr'] === 'refused' ? "Refused: your access can't open the build PRs that write them." : null;
  return [
    { id: 'repository', value: where, title: existing ? `Use ${paths}` : `Start ${paths} in the repository`, refused: !!refusal,
      cost: refusal ?? (existing ? 'Build PRs add entries there, and teammates review them.' : 'A later build PR adds them for review. Nothing is written now.') },
    { id: 'private', value: { kind: 'private' }, title: 'Keep private drafts', cost: 'Only you see them, on this Mac, until a build PR publishes them.' },
  ];
}

/** Each operation's title on GitHub and on Azure DevOps, and the cost line of each one onboarding offers. */
const OPERATIONS: Record<RepositoryOperation, { title: [string, string]; cost?: string }> = {
  'push-branch': { title: ['Push branches', 'Push branches'], cost: 'Builds push their work to a branch here. Off: builds stay on this Mac.' },
  'open-pr': { title: ['Open pull requests', 'Open pull requests'], cost: 'How builds deliver. Off: builds stop at a pushed branch.' },
  'publish-ticket': { title: ['Open issues', 'Create work items'] },
  'edit-ticket': { title: ['Edit issues', 'Edit work items'], cost: "You can edit a ticket's description in its item dialog. Off: the dialog only shows it." },
  'tag-ticket': { title: ['Add labels', 'Add tags'] },
  'comment-ticket': { title: ['Post comments', 'Post comments'] },
  'type-ticket': { title: ['Set issue types', 'Set work item types'] },
  'relate-ticket': { title: ['Link issues', 'Link work items'] },
};

/** The operation's title on the detected provider. */
export const operationTitle = (op: RepositoryOperation, detection: SetupDetection) => OPERATIONS[op].title[detection.provider === 'Azure DevOps' ? 1 : 0];

/**
 * What the factory may write, each operation Refused or unverified as the login's permissions show it. The writes only
 * publishing uses aren't offered: the consent step's later line names them.
 */
export function consentOptions(detection: SetupDetection): Option<RepositoryOperation>[] {
  return OFFERED_OPERATIONS.map((op) => {
    const access = detection.access[op];
    return { id: op, value: op, title: operationTitle(op, detection), refused: access === 'refused', unverified: access === 'unverified',
      cost: access === 'refused' ? `Refused: your ${detection.provider} access doesn't allow it.` : OPERATIONS[op].cost! };
  });
}

/** The project skills to select as coding guidance: each one found, with the shared default's. */
export function skillOptions(detection: SetupDetection): Option<string>[] {
  const names = [...new Set([...found(detection.projectSkills) ?? [], ...sharedOf(detection).skills ?? []])];
  return names.map((name) => ({ id: name, value: name, title: name, cost: 'Builds follow it when they write and test code.' }));
}

const FILES: Record<FactoryFileKind, { title: (paths: string[]) => string; cost: string }> = {
  config: { title: () => '.lar-factory.json', cost: 'Teammates who onboard start from its shared defaults.' },
  'agent-skills': { title: (paths) => `## Agent skills in ${paths.join(' and ')}`, cost: 'Agents read the factory\'s skills from it. Threads carry them anyway.' },
  'agent-docs': { title: (paths) => paths.join(', '), cost: 'Agents read the factory\'s tracker and domain notes there.' },
};

/** The other onboarded repositories to connect `repo` to, each with its Repository role. */
export function connectionOptions(repo: string, onboarded: readonly RepoConfig[]): Option<string>[] {
  return onboarded.filter((other) => !sameRepo(other.repo, repo))
    .map((other) => ({ id: other.repo, value: other.repo, title: shownRepo(other.repo), cost: other.role || 'No Repository role yet.' }));
}

/** Text as its words, lowercase and spaced, so a repository's name matches with hyphens, underscores or spaces. */
const words = (text: string) => ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;

/** Whether `role` names the repository `repo` by its name. */
const names = (role: string, repo: string) => words(role).includes(words(repo.split('/').at(-1)!));

/**
 * The Connections step's guesses: each other onboarded repository already connected to `repo`, or whose Repository
 * role names `repo`, or that `role` names.
 */
function guessedConnections(repo: string, role: string, onboarded: readonly RepoConfig[]): string[] {
  return connectionOptions(repo, onboarded).map((o) => onboarded.find((r) => r.repo === o.value)!)
    .filter((other) => other.setup?.connections?.some((c) => sameRepo(c, repo)) || names(other.role, repo) || names(role, other.repo))
    .map((other) => other.repo);
}

/** The repositories to connect `repo` to: the ones ticked, else the guesses, each another onboarded repository. */
export function connectionsOf(repo: string, role: string, choices: OnboardingChoices, onboarded: readonly RepoConfig[]): string[] {
  const offered = connectionOptions(repo, onboarded).map((o) => o.value);
  return choices.connections ? offered.filter((r) => choices.connections!.some((c) => sameRepo(c, r))) : guessedConnections(repo, role, onboarded);
}

/** The factory files of an earlier setup, each one to keep or drop; dropping is Refused when the PR it needs is. */
export function fileOptions(detection: SetupDetection): Option<FactoryFile>[] {
  const refused = prRefused(detection);
  return (found(detection.factoryFiles) ?? []).map((file) => ({ id: file.kind, value: file, title: FILES[file.kind].title(file.paths), refused,
    cost: refused ? "Refused: your access can't open the PR that drops it." : FILES[file.kind].cost }));
}

/** The detected defaults: the shared .lar-factory.json's, else what detection found, skipping any option access refuses; no project skill unless the shared config selects it. */
export function defaultsOf(detection: SetupDetection): Answers {
  const shared = sharedOf(detection);
  const docs = docsOptions(detection);
  const docsDefault = shared.domainDocs ?? found(detection.domainDocs) ?? { kind: 'private' };
  return {
    itemSource: shared.itemSource ?? sourceOptions(detection)[0]?.value ?? null,
    role: shared.role ?? '',
    consent: OFFERED_OPERATIONS.filter((op) => detection.access[op] === 'allowed'),
    domainDocs: docsDefault.kind === 'repository' && docs[0]!.refused ? { kind: 'private' } : docsDefault,
    // Only the skills the user selects guide builds, so none starts ticked unless the shared config selects it.
    skills: shared.skills ?? [],
    drop: [],
  };
}

/** The run's answers: each choice, else its detected default, less consent that access refuses or nothing offers, and drops access refuses. */
export function answersOf(detection: SetupDetection, choices: OnboardingChoices): Answers {
  const answers = { ...defaultsOf(detection), ...choices };
  return {
    ...answers,
    consent: answers.consent.filter((op) => OFFERED_OPERATIONS.includes(op) && detection.access[op] !== 'refused'),
    drop: prRefused(detection) ? [] : answers.drop.filter((kind) => found(detection.factoryFiles)?.some((file) => file.kind === kind)),
  };
}

/** Where an answer stands: the user changed it, the shared .lar-factory.json gave it, or detection did. */
export type Origin = 'changed' | 'shared' | 'detected';

export function originOf(detection: SetupDetection, choices: OnboardingChoices, key: keyof Answers): Origin {
  if (choices[key] !== undefined && JSON.stringify(choices[key]) !== JSON.stringify(defaultsOf(detection)[key])) return 'changed';
  return key !== 'consent' && key !== 'drop' && sharedOf(detection)[key] !== undefined ? 'shared' : 'detected';
}

/** What a step stays blocked on, or null: an answer it needs that it doesn't have. */
export function answerProblem(step: StepId, answers: Answers): string | null {
  if (step === 'source' && !answers.itemSource) return 'Choose a team to continue.';
  if (step === 'role' && !answers.role.trim()) return 'Describe what this repository does to continue.';
  return null;
}

/**
 * The lines a step says about the choices it leaves for later, each asked when a feature first needs it: the shared
 * .lar-factory.json where there is none, labels or tags and agent guidance, publication with its vocabulary mapping,
 * publishing private drafts, and Clash resolution.
 */
export function laterLines(step: StepId, detection: SetupDetection | null): string[] {
  const azure = detection?.provider === 'Azure DevOps';
  if (step === 'detect' && detection) {
    return [
      ...found(detection.sharedConfig) === null && 'found' in detection.sharedConfig
        ? ["You'll be offered a shared Repository config when a setting is worth sharing with your team."] : [],
      `${azure ? 'Tags' : 'Labels'} and agent guidance for the repository are offered when a feature would use them.`,
    ];
  }
  if (step === 'consent') {
    return [`You'll choose whether the factory may ${azure ? 'create and tag work items' : 'open and label issues'}, map its kinds to your ${azure ? 'work item types and tags' : 'labels'} and choose how to publish the first time you publish refined work.`];
  }
  if (step === 'docs') return ["You'll choose whether to publish private drafts when a build first writes them."];
  if (step === 'skills') return ["If a project rule blocks factory work, you'll choose how to resolve it then."];
  return [];
}
