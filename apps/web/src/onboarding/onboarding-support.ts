// What the onboarding page tests share: a board with no repository onboarded, and T3's projects for the server to list.

import { vi } from 'vite-plus/test';
import { $, fetchMock, mountPage, sample, settle } from '../../test/support.ts';
import type { BoardData, ProjectChoice, SetupDetection } from '@lar-factory/shared';

export const empty: BoardData = { ...sample, repos: [], items: [], repositoryConfigProblems: [], error: null };

export const project = (name: string, parts: Partial<ProjectChoice> = {}): ProjectChoice => ({
  id: name, name, folder: `/Users/me/Developer/${name}`, repo: `maddec01/${name}`, provider: 'GitHub', hasConfig: false, onBoard: false, ...parts,
});

/** A board answer to an onboarding call: a body, or one made from the call's body; an `error` answers 502 unless it's a Response. */
export type Route = object | ((body: Record<string, unknown>) => object | Response);

/**
 * Serves `data` as the board and `projects` as T3's projects, answers each onboarding kept with `keep` and `status`,
 * and each call `routes` names with its answer.
 */
export function serve(data: BoardData, projects: ProjectChoice[] | { error: string }, keep: object = { error: null }, status = 200, routes: Record<string, Route> = {}): void {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const route = routes[url];
    if (route) {
      const answer = typeof route === 'function' ? route(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>) : route;
      return answer instanceof Response ? answer : new Response(JSON.stringify(answer), { status: 'error' in answer && answer.error ? 502 : 200 });
    }
    return url === '/api/onboarding/projects'
      ? new Response(JSON.stringify(Array.isArray(projects) ? { projects } : projects), { status: Array.isArray(projects) ? 200 : 502 })
      : url === '/api/onboarding/repositories' ? new Response(JSON.stringify(keep), { status })
      : new Response(JSON.stringify(data));
  });
}

/** The body of each post to `url` the page made, in order. */
export const posted = (url: string) => (fetchMock.mock.calls as unknown as [string, RequestInit?][]).filter(([u, init]) => u === url && init?.body !== undefined)
  .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);

/** A GitHub repository the login owns, with no domain docs, factory files, shared config or project skills. */
export const detection = (parts: Partial<SetupDetection> = {}): SetupDetection => ({
  repo: 'maddec01/lar-web', provider: 'GitHub', checkout: { found: '/Users/me/Developer/lar-web' }, itemSources: { found: [{ kind: 'issues' }] },
  access: { 'push-branch': 'allowed', 'open-pr': 'allowed', 'publish-ticket': 'allowed', 'edit-ticket': 'allowed', 'tag-ticket': 'allowed', 'comment-ticket': 'unverified', 'type-ticket': 'unverified', 'relate-ticket': 'unverified' },
  domainDocs: { found: { kind: 'private' } }, factoryFiles: { found: [] }, sharedConfig: { found: null }, projectSkills: { found: [] }, ...parts,
});

export const dialog = () => $('[data-onboarding-dialog]');

/**
 * Mounts `data`, the empty board unless it says otherwise, and opens the onboarding dialog, from the empty state when
 * the board has no repository, with the onboarding calls `routes` names answered.
 */
export async function openOnboarding(projects: ProjectChoice[] | { error: string }, routes: Record<string, Route> = {}, data: BoardData = empty): Promise<void> {
  serve(data, projects, { error: null }, 200, routes);
  await mountPage(data);
  if (!data.repos.length) return settle(() => $<HTMLButtonElement>('[data-onboard]')!.click());
  const { useWizardStore } = await import('./wizard-store.ts');
  await settle(() => useWizardStore.getState().start());
}
