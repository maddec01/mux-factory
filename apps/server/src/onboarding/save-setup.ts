// Onboarding's last step: its answers become the repository's local settings, and the repository goes on the board.
// Nothing is written to the repository; the shared .lar-factory.json, when there is one, is only read, so an answer
// equal to its default inherits it.

import { REPOSITORY_OPERATIONS, isRecord, onAzure, type LocalSetupAnswers, type OnboardingRepository, type RepositoryOperation } from '@lar-factory/shared';
import { boardDataDir } from '@lar-factory/shared/data-dir';
import { isRepo, saveConnections, saveOnboarded, stillOnboarding } from '../config/repository-config.ts';
import { readSharedDefaults, saveLocalSetup, sharedDefaultsOf } from '../config/repository-settings.ts';
import { message } from '../github/github.ts';
import { detectAccess } from './detect-setup.ts';

/** What saving reads: the repository's .lar-factory.json, and what the login's permissions allow. */
export interface SaveReads {
  shared(repo: string): Promise<Parameters<typeof saveLocalSetup>[3]>;
  access(repo: string): Promise<Parameters<typeof saveLocalSetup>[2]>;
}

const saveReads: SaveReads = { shared: async (repo) => (await readSharedDefaults(repo)).read, access: (repo) => detectAccess(repo) };

const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === 'string');

/** The body's answers, or null when one is missing or has the wrong shape. */
function answersOf({ projectId, role, itemSource, domainDocs, skills, consent }: Record<string, unknown>): LocalSetupAnswers | null {
  const docs = isRecord(domainDocs) && (domainDocs.kind === 'private'
    || domainDocs.kind === 'repository' && typeof domainDocs.glossary === 'string' && typeof domainDocs.adrs === 'string');
  if (typeof projectId !== 'string' || typeof role !== 'string' || !isRecord(itemSource) || !docs || !strings(skills)
    || !Array.isArray(consent) || !consent.every((op) => REPOSITORY_OPERATIONS.includes(op as RepositoryOperation))) return null;
  return { projectId, role: role.trim(), itemSource, domainDocs, skills, consent } as LocalSetupAnswers;
}

const ANSWERS = 'Send the repository, its T3 project, role, item source, domain-doc location, skills and write consent.';

/**
 * Saves the body's answers as its `repo`'s local settings and finishes its onboarding, in place of the one saved under
 * `replaces` when it names one. Its `connections`, when it sends them, become the repository's Connections. Returns the repositories still onboarding, or the status and problem. An access read
 * that fails leaves every operation unverified.
 */
export async function saveSetup(input: Record<string, unknown>, dir = boardDataDir(), reads: SaveReads = saveReads):
  Promise<{ onboarding: OnboardingRepository[] } | { status: number; error: string }> {
  const { repo, replaces, connections } = input;
  const answers = answersOf(input);
  if (!isRepo(repo) || !answers || replaces !== undefined && typeof replaces !== 'string' || connections !== undefined && !strings(connections)) {
    return { status: 400, error: ANSWERS };
  }
  const { role, itemSource, domainDocs, skills } = answers;
  const fits = sharedDefaultsOf({ role, itemSource, domainDocs, skills }, onAzure(repo));
  if ('problem' in fits) return { status: 400, error: `${repo}: ${fits.problem.replace(/^\.lar-factory\.json /, '')}` };
  let shared;
  try { shared = await reads.shared(repo); }
  catch (err) { return { status: 502, error: `Can't read ${repo}'s .lar-factory.json: ${message(err)}` }; }
  const access = await reads.access(repo).catch(() => ({}));
  try {
    const list = saveOnboarded(repo, replaces ?? null, dir);
    saveLocalSetup(repo, answers, access, shared, dir);
    if (connections) saveConnections(repo, connections, dir);
    return { onboarding: stillOnboarding(list) };
  } catch (err) {
    return { status: 409, error: message(err) };
  }
}
