// Each repository's local settings, kept as `settings` in its entry of the repository list, and the setup they make
// with the shared defaults of its optional .lar-factory.json. A local override wins over a shared default, and removing
// it inherits the default again. Credentials and write consent are only ever local.

import { join } from 'node:path';
import {
  CONFIG_VERSION, VOCABULARY_KEYS, effectiveVocabulary, isVocabularyMapping, type VocabularyKey, type VocabularyTerm, REPOSITORY_OPERATIONS, SHARED_SETTINGS, isRecord, onAzure, sameRepo, type DomainDocLocation, type OperationAccess,
  type LocalSetupAnswers, type RepositoryItemSource, type RepositoryOperation, type RepositorySetup, type SharedRepositorySettings,
} from '@lar-factory/shared';
import { REPOSITORY_LIST_FILE, boardDataDir } from '@lar-factory/shared/data-dir';
import {
  connectedTo, isItemSource, readListFile, writeListFile,
} from './repository-list.ts';

/** The settings that pause the work depending on them when they change. */
type PausingSetting = RepositorySetup['paused'][number];

/** One repository's local settings as its list entry keeps them. */
interface LocalSettings {
  projectId?: string;
  /** The shared settings the user set on this Mac, each in place of Repository config's. */
  overrides?: SharedRepositorySettings;
  /** What the credentials were found to allow; an operation it leaves out is unverified. */
  access?: Partial<Record<RepositoryOperation, Exclude<OperationAccess, 'unverified'>>>;
  /** The operations the user allows the factory to offer, whatever the credentials allow. */
  consent?: RepositoryOperation[];
  /** Repository config's defaults as last read while usable. */
  shared?: SharedRepositorySettings;
  /** Why the latest read of Repository config couldn't be used. */
  sharedProblem?: string;
  /** The pausing settings as the user last accepted them. */
  accepted?: { itemSource: RepositoryItemSource | null; domainDocs: DomainDocLocation };
  /** The app's Repository config version at which the user dismissed the notice offering the update PR. */
  dismissedUpdate?: number;
}

const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === 'string');
const isOperation = (value: unknown): value is RepositoryOperation => REPOSITORY_OPERATIONS.includes(value as RepositoryOperation);

const isDomainDocs = (value: unknown): value is DomainDocLocation => isRecord(value)
  && (value.kind === 'private' || value.kind === 'repository' && typeof value.glossary === 'string' && typeof value.adrs === 'string');

/** What is wrong with a shared setting's value, or null when nothing is. An Azure DevOps repository's item source names a team. */
function sharedProblemOf(raw: Record<string, unknown>, azure: boolean): string | null {
  const source = raw.itemSource;
  if ('version' in raw && (typeof raw.version !== 'number' || !Number.isFinite(raw.version))) return 'field version must be a number';
  if ('role' in raw && typeof raw.role !== 'string') return 'field role must be a string';
  if ('itemSource' in raw && (!isItemSource(source) || source.kind !== (azure ? 'azure-board' : 'issues'))) {
    return azure ? 'field itemSource must name the Azure DevOps team whose board the board reads' : 'field itemSource must be {"kind": "issues"}';
  }
  if ('labels' in raw && !isStrings(raw.labels)) return 'field labels must be an array of strings';
  if ('domainDocs' in raw && !isDomainDocs(raw.domainDocs)) return 'field domainDocs must be {"kind": "private"} or name the repository\'s glossary and adrs paths';
  if ('vocabulary' in raw && !isVocabularyMapping(raw.vocabulary)) return 'field vocabulary must map concept, build and kinds to {type: string or null, labels: string[]}';
  if ('skills' in raw && !isStrings(raw.skills)) return 'field skills must be an array of strings';
  return null;
}

/**
 * The shared settings `raw` holds, every field optional, leaving out anything else, such as credentials, consent or
 * the old `show` setting.
 */
function sharedSettingsOf(raw: Record<string, unknown>): SharedRepositorySettings {
  const { role, itemSource, labels, domainDocs, skills, vocabulary } = raw as SharedRepositorySettings;
  return {
    ...role !== undefined && { role }, ...itemSource !== undefined && { itemSource },
    ...labels !== undefined && { labels }, ...domainDocs !== undefined && { domainDocs }, ...skills !== undefined && { skills }, ...vocabulary !== undefined && { vocabulary },
  };
}

/** A parsed .lar-factory.json's shared defaults, or the problem that keeps them from use. */
export function sharedDefaultsOf(raw: Record<string, unknown>, azure: boolean): { defaults: SharedRepositorySettings } | { problem: string } {
  const problem = sharedProblemOf(raw, azure);
  return problem ? { problem: `.lar-factory.json ${problem}.` } : { defaults: sharedSettingsOf(raw) };
}

const isAccess = (value: unknown) => isRecord(value)
  && Object.entries(value).every(([op, access]) => isOperation(op) && (access === 'allowed' || access === 'refused'));

/** Whether an entry's `settings` has its shape, for a repository on Azure DevOps or not. */
function isLocalSettings(value: unknown, azure: boolean): value is LocalSettings {
  if (!isRecord(value)) return false;
  const shared = (v: unknown) => v === undefined || isRecord(v) && sharedProblemOf(v, azure) === null;
  const accepted = value.accepted;
  return (value.projectId === undefined || typeof value.projectId === 'string') && shared(value.overrides) && shared(value.shared)
    && (value.access === undefined || isAccess(value.access)) && (value.consent === undefined || Array.isArray(value.consent) && value.consent.every(isOperation))
    && (value.sharedProblem === undefined || typeof value.sharedProblem === 'string')
    && (value.dismissedUpdate === undefined || typeof value.dismissedUpdate === 'number')
    && (accepted === undefined || isRecord(accepted) && (accepted.itemSource === null || isItemSource(accepted.itemSource)) && isDomainDocs(accepted.domainDocs));
}

/** The list's entries with their checked local settings; throws, naming the entry, for settings it can't use. */
function readSettings(dir: string) {
  const file = join(dir, REPOSITORY_LIST_FILE);
  const { raw, list } = readListFile(file);
  const settings = raw.repositories.map((entry, index): LocalSettings => {
    if (entry.settings === undefined) return {};
    if (!isLocalSettings(entry.settings, onAzure(list[index]!.repo))) throw new Error(`${file}: repositories[${index}] has local settings it can't use.`);
    return entry.settings;
  });
  return { raw, list, settings };
}

/** The setup that the repository's local settings and its Connections make. */
function setupOf(repo: string, local: LocalSettings, connections: string[] = []): RepositorySetup {
  const pick = <K extends keyof SharedRepositorySettings>(key: K) => local.overrides?.[key] ?? local.shared?.[key];
  const accessOf = (op: RepositoryOperation): OperationAccess => local.access?.[op] ?? 'unverified';
  const itemSource = pick('itemSource') ?? (onAzure(repo) ? null : { kind: 'issues' as const });
  const domainDocs = pick('domainDocs') ?? { kind: 'private' as const };
  const changed = (key: PausingSetting, now: unknown) => local.accepted !== undefined && JSON.stringify(local.accepted[key]) !== JSON.stringify(now);
  return {
    repo, ...local.projectId !== undefined && { projectId: local.projectId },
    role: pick('role') ?? '', itemSource, labels: pick('labels') ?? [], domainDocs, skills: pick('skills') ?? [],
    ...effectiveVocabulary(local.overrides?.vocabulary, local.shared?.vocabulary),
    access: Object.fromEntries(REPOSITORY_OPERATIONS.map((op) => [op, accessOf(op)])) as RepositorySetup['access'],
    consent: (local.consent ?? []).filter((op) => accessOf(op) !== 'refused'),
    paused: (['itemSource', 'domainDocs'] as const).filter((key) => changed(key, key === 'itemSource' ? itemSource : domainDocs)),
    ...local.sharedProblem !== undefined && { sharedProblem: local.sharedProblem },
    sources: Object.fromEntries(SHARED_SETTINGS.map((key) => [key,
      local.overrides?.[key] !== undefined ? 'local' : local.shared?.[key] !== undefined ? 'shared' : 'default'])) as RepositorySetup['sources'],
    shared: local.shared ?? {},
    connections,
  };
}

/** Each listed repository's setup, in the list's order. */
export function readRepositorySetups(dir = boardDataDir()): RepositorySetup[] {
  const { raw, list, settings } = readSettings(dir);
  return list.map(({ repo }, index) => setupOf(repo, settings[index]!, connectedTo(repo, raw.connections, list)));
}

/**
 * Writes the repository's local settings as `change` makes them from the saved ones and the setup they make, first
 * accepting the pausing settings as they are when the user never accepted any. Throws for a repository the list
 * doesn't name.
 */
function updateSettings(repo: string, dir: string, change: (local: LocalSettings, setup: RepositorySetup) => LocalSettings): void {
  const { raw, list, settings } = readSettings(dir);
  const at = list.findIndex((e) => sameRepo(e.repo, repo));
  if (at < 0) throw new Error(`${repo} is not on this Mac's list.`);
  const saved = settings[at]!;
  const setup = setupOf(list[at]!.repo, saved);
  const { itemSource, domainDocs } = setup;
  const changed = change({ ...saved, accepted: saved.accepted ?? { itemSource, domainDocs } }, setup);
  // Naming an Azure DevOps repository's first team changes no work, as none could read its items before.
  const next = changed.accepted?.itemSource === null
    ? { ...changed, accepted: { ...changed.accepted, itemSource: setupOf(list[at]!.repo, changed).itemSource } } : changed;
  // Each refresh applies the shared defaults again, so an unchanged setup leaves the file alone.
  if (JSON.stringify(next) === JSON.stringify(saved)) return;
  writeListFile(dir, { ...raw, repositories: raw.repositories.map((e, i) => i === at ? { ...e, settings: next } : e) });
}

/**
 * Keeps the latest read of the repository's .lar-factory.json: its defaults when usable, nothing when the repository
 * has none, or, for a file that is wrong or can't be read, the last usable defaults with the problem.
 */
export function applySharedDefaults(repo: string, read: { defaults: SharedRepositorySettings } | { problem: string } | null, dir = boardDataDir()): void {
  updateSettings(repo, dir, ({ shared, sharedProblem: _, ...local }) => {
    if (read === null) return local;
    if ('problem' in read) return { ...local, ...shared && { shared }, sharedProblem: read.problem };
    return { ...local, shared: read.defaults };
  });
}

/** Sets the repository's local override of a shared setting, or removes it with undefined, so the shared default applies again. */
export function setOverride<K extends keyof SharedRepositorySettings>(repo: string, key: K, value: SharedRepositorySettings[K] | undefined, dir = boardDataDir()): void {
  const problem = value === undefined ? null : sharedProblemOf({ [key]: value }, onAzure(repo));
  if (problem) throw new Error(`${repo}: ${problem}.`);
  updateSettings(repo, dir, ({ overrides = {}, ...local }) => {
    const { [key]: _, ...others } = overrides;
    return { ...local, overrides: value === undefined ? others : { ...others, [key]: value } };
  });
}

/** Change one local mapping. Undefined removes only that override and restores inheritance. */
export function setVocabularyOverride(repo: string, key: VocabularyKey, value: VocabularyTerm | undefined, dir = boardDataDir()): void {
  if (!VOCABULARY_KEYS.includes(key) || value !== undefined && !isVocabularyMapping({ [key]: value })) throw new Error('Send a Vocabulary term and its type and labels, or omit the value to inherit.');
  updateSettings(repo, dir, ({ overrides = {}, ...local }) => {
    const { [key]: _, ...vocabulary } = overrides.vocabulary ?? {};
    return { ...local, overrides: { ...overrides, vocabulary: value === undefined ? vocabulary : { ...vocabulary, [key]: value } } };
  });
}

/** Accepts the repository's item source and domain-doc location as they are now, so the work depending on them goes on. */
export function acceptSetup(repo: string, dir = boardDataDir()): void {
  updateSettings(repo, dir, (local, { itemSource, domainDocs }) => ({ ...local, accepted: { itemSource, domainDocs } }));
}

/** Records the repository's config update notice dismissed at the app's Repository config `version`. */
export function recordDismissedUpdate(repo: string, version: number, dir = boardDataDir()): void {
  updateSettings(repo, dir, (local) => ({ ...local, dismissedUpdate: version }));
}

/** Each repository whose config update notice was dismissed, with the app version it was dismissed at. */
export function readDismissedUpdates(dir = boardDataDir()): Map<string, number> {
  const { list, settings } = readSettings(dir);
  return new Map(list.flatMap(({ repo }, index) => {
    const at = settings[index]!.dismissedUpdate;
    return at === undefined ? [] : [[repo, at] as const];
  }));
}

/** The access an onboarding's detection found, each operation it left unverified out. */
type FoundAccess = NonNullable<LocalSettings['access']>;

/**
 * Saves onboarding's answers as the repository's local settings over the latest read of its .lar-factory.json, with
 * the access its detection found. An answer equal to the shared default inherits it, so a later shared change applies;
 * any other answer is a local override. The setup it makes is accepted, so no work waits on it.
 */
export function saveLocalSetup(repo: string, answers: LocalSetupAnswers, access: FoundAccess, read: SharedRead, dir = boardDataDir()): void {
  const { projectId, consent, ...answered } = answers;
  updateSettings(repo, dir, ({ shared, sharedProblem: _, overrides: previousOverrides, ...local }) => {
    const kept: LocalSettings = read === null ? local : 'problem' in read
      ? { ...local, ...shared && { shared }, sharedProblem: read.problem } : { ...local, shared: read.defaults };
    const overrides = { ...previousOverrides?.vocabulary !== undefined && { vocabulary: previousOverrides.vocabulary }, ...Object.fromEntries(Object.entries(answered)
      .filter(([key, value]) => JSON.stringify(kept.shared?.[key as keyof SharedRepositorySettings]) !== JSON.stringify(value))) };
    const saved = { ...kept, projectId, overrides, access, consent: [...consent] };
    const { itemSource, domainDocs } = setupOf(repo, saved);
    return { ...saved, accepted: { itemSource, domainDocs } };
  });
}

/** Sets the operations the user allows the factory to offer for the repository. */
export function setConsent(repo: string, consent: readonly RepositoryOperation[], dir = boardDataDir()): void {
  updateSettings(repo, dir, (local) => ({ ...local, consent: [...consent] }));
}

/**
 * Sets the operations Settings offers for the repository, each one the credentials don't refuse. The consent given for
 * an operation the credentials refuse now stays, so it comes back once a recheck finds the access again.
 */
export function changeConsent(repo: string, consent: readonly RepositoryOperation[], dir: string): void {
  updateSettings(repo, dir, (local) => {
    const refused = (op: RepositoryOperation) => local.access?.[op] === 'refused';
    const blocked = consent.find(refused);
    if (blocked) throw new Error(`The credentials for ${repo} refuse ${blocked}, so the board can't offer it.`);
    const kept = (local.consent ?? []).filter(refused);
    return { ...local, consent: REPOSITORY_OPERATIONS.filter((op) => consent.includes(op) || kept.includes(op)) };
  });
}

/** Records what an attempted operation found the credentials allow. */
export function recordAccess(repo: string, op: RepositoryOperation, access: Exclude<OperationAccess, 'unverified'>, dir = boardDataDir()): void {
  updateSettings(repo, dir, (local) => ({ ...local, access: { ...local.access, [op]: access } }));
}

/** Forgets what the credentials allowed, after they changed, so each operation is checked again when next needed. */
export function recheckAccess(repo: string, dir = boardDataDir()): void {
  updateSettings(repo, dir, ({ access: _, ...local }) => local);
}

type SharedRead = Parameters<typeof applySharedDefaults>[1];

/** A .lar-factory.json's text as applySharedDefaults takes it, with its version. */
export function sharedConfigOf(text: string, azure: boolean): { read: Exclude<SharedRead, null>; version: number } {
  let raw: unknown;
  try { raw = JSON.parse(text); }
  catch { return { read: { problem: ".lar-factory.json isn't valid JSON." }, version: CONFIG_VERSION }; }
  if (!isRecord(raw)) return { read: { problem: ".lar-factory.json isn't a JSON object." }, version: CONFIG_VERSION };
  const read = sharedDefaultsOf(raw, azure);
  return { read, version: 'defaults' in read && typeof raw.version === 'number' ? raw.version : CONFIG_VERSION };
}


export * from "./repository-list.ts";
