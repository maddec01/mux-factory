// The board's card for each repository still onboarding, titled with its name, whose Resume reopens the dialog where it stopped.

import { expect, test, vi } from 'vite-plus/test';
import { $, $$, mountPage, sample, settle, text, toast } from '../../test/support.ts';
import type { BoardData } from '@lar-factory/shared';
import { detection, dialog, empty, project, serve } from './onboarding-support.ts';

const waiting = (data: BoardData, step = 'role'): BoardData => ({ ...data,
  onboarding: [{ repo: 'maddec01/lar-web', progress: { step, done: ['project'], answers: { projectId: 'lar-web' } } }] });

const card = () => $('[data-onboarding-card="maddec01/lar-web"]');

async function resume(): Promise<void> {
  await settle(() => card()!.querySelector<HTMLButtonElement>('[data-resume]')!.click());
}

test('a repository still onboarding shows its card with its step instead of the empty state', async () => {
  serve(waiting(empty), []);
  await mountPage(waiting(empty));
  expect($('[data-empty-state]')).toBeNull();
  expect(text(card()!.querySelector('h2'))).toBe('maddec01/lar-web');
  expect(text(card())).toContain('Setting up');
  expect(text(card())).toContain('Stopped at Repository role');
  expect(text(card()!.querySelector('[data-resume]'))).toBe('Resume');
});

test("a card for an older board's onboarding says it stopped at the first step", async () => {
  const pr = { step: 'pr', done: ['project', 'setup', 'checks'], answers: { projectId: 'lar-web' } };
  const data: BoardData = { ...empty, onboarding: [{ repo: 'maddec01/lar-web', progress: pr }] };
  serve(data, []);
  await mountPage(data);
  expect(text(card())).toContain('Stopped at Repository');
});

test("an Azure DevOps repository's card shows its name decoded, and its step", async () => {
  const repo = 'contoso/Fabrikam%20Fiber/lar-api';
  const data: BoardData = { ...empty, onboarding: [{ repo, progress: { step: 'source', done: ['project', 'detect'], answers: { projectId: 'lar-api', provider: 'Azure DevOps' } } }] };
  serve(data, []);
  await mountPage(data);
  const azure = $(`[data-onboarding-card="${repo}"]`)!;
  expect(text(azure.querySelector('h2'))).toBe('contoso/Fabrikam Fiber/lar-api');
  expect(text(azure)).toContain('Stopped at Item source');
});

test('the card sits above the board of the repositories onboarded already', async () => {
  serve(waiting(sample), []);
  await mountPage(waiting(sample));
  expect(card()).not.toBeNull();
  expect($('.desk')).not.toBeNull();
  expect($$('[data-onboarding-card]')).toHaveLength(1);
});

test('Resume reopens the dialog on the stored step with the stored project', async () => {
  serve(waiting(empty, 'detect'), [project('lar-web', { onBoard: true })], { error: null }, 200, { '/api/onboarding/detect': { detection: detection(), error: null } });
  await mountPage(waiting(empty, 'detect'));
  await resume();
  expect(text(dialog()!.querySelector('[data-slot="modal-header"] h2'))).toBe('What we found');
  expect(text(dialog()!.querySelector('#onboarding-place'))).toBe('Set up lar-web. Step 2 of 8.');
  await settle(() => [...dialog()!.querySelectorAll<HTMLButtonElement>('[data-slot="modal-footer"] button')].find((b) => text(b).includes('Back'))!.click());
  const radio = dialog()!.querySelector('[data-choice="lar-web"] [role="radio"]')!;
  expect(radio.getAttribute('aria-checked')).toBe('true');
  expect(radio.hasAttribute('data-disabled'), 'its own project stays pickable').toBe(false);
});

test("closing a run the server can't keep says why in a toast", async () => {
  serve(waiting(empty), [project('lar-web', { onBoard: true })], { error: 'maddec01/lar-web is ready already.' }, 409);
  await mountPage(waiting(empty));
  await resume();
  await settle(() => dialog()!.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click());
  expect(text(toast())).toContain('Couldn\'t keep onboarding maddec01/lar-web on the board. maddec01/lar-web is ready already.');
});
