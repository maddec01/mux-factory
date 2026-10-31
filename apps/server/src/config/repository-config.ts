import { onAzure, type RepositoryItemSource } from '@lar-factory/shared';
import { isItemSource, sharedDefaultsOf, type RepositoryConfig } from '@lar-factory/shared/repository-settings';
import { readBranchFile as readAzureFile } from '../azure/azure-repos.ts';
import { readBranchFile } from '../github/github.ts';
export { isRepo, isItemSource, isProgress, readRepositoryList, saveConnections, saveOnboarding, saveOnboarded, onTheBoard, stillOnboarding, readBoardSettings } from '@lar-factory/shared/repository-settings';
export type { RepositoryConfig, OnboardedRepository } from '@lar-factory/shared/repository-settings';

/**
 * What is wrong with a parsed .lar-factory.json, in repo-config.sh's words, or null when nothing is. A GitHub repository
 * reads its issues, and an Azure DevOps one names its team's combined board, with no default.
 */
function problem(raw: Record<string, unknown>, azure: boolean): string | null {
  const source = raw.itemSource as Record<string, unknown> | undefined;
  if ('version' in raw && typeof raw.version !== 'number') return 'field version must be a number';
  if (typeof raw.role !== 'string' || !raw.role) return 'field role is missing or not a string';
  if ('itemSource' in raw && (typeof source !== 'object' || source === null || Array.isArray(source))) return 'field itemSource must be an object';
  if (source && source.kind !== (azure ? 'azure-board' : 'issues') || azure && !source) return 'has an unsupported item source. Run onboarding again';
  if (azure && !isItemSource(source)) return 'name the Azure DevOps team whose backlog and current sprint the board reads';
  if ('labels' in raw && (!Array.isArray(raw.labels) || raw.labels.some((l) => typeof l !== 'string'))) return 'field labels must be an array of strings';
  return null;
}

/**
 * The repository's .lar-factory.json from its default branch, or from `branch` when given, never a checkout, with
 * defaults filled in; null when it has none, or why the one it has is wrong. An Azure DevOps repository's file is read
 * with az, any other's with gh, and `run` stands in for that tool. Throws any other failure, such as a
 * logged-out gh or az.
 */
export async function findRepositoryConfig(repo: string, run?: (args: string[]) => Promise<string>, branch?: string): Promise<RepositoryConfig | { problem: string } | null> {
  const text = await (onAzure(repo) ? readAzureFile : readBranchFile)(repo, '.lar-factory.json', branch, run);
  if (text === null) return null;
  let raw: unknown;
  try { raw = JSON.parse(text); }
  catch { return { problem: ".lar-factory.json isn't valid JSON." }; }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { problem: ".lar-factory.json isn't a JSON object." };
  const wrong = problem(raw as Record<string, unknown>, onAzure(repo));
  if (wrong) return { problem: `.lar-factory.json ${wrong}.` };
  const shared = sharedDefaultsOf(raw as Record<string, unknown>, onAzure(repo));
  if ('problem' in shared) return shared;
  const file = raw as Partial<RepositoryConfig> & { role: string };
  const source = file.itemSource;
  const itemSource: RepositoryItemSource = source?.kind === 'azure-board' ? { kind: 'azure-board', team: source.team } : { kind: 'issues' };
  return { repo, version: file.version ?? 1, role: file.role, itemSource, labels: file.labels ?? [],
    ...shared.defaults.vocabulary !== undefined && { vocabulary: shared.defaults.vocabulary },
    ...shared.defaults.domainDocs !== undefined && { domainDocs: shared.defaults.domainDocs },
    ...shared.defaults.skills !== undefined && { skills: shared.defaults.skills },
  };
}
