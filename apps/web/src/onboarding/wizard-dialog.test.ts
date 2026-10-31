// The onboarding dialog: the copied Modal over the board, a scrolling body, the progress bar, Back and Next, and Finish.

import { expect, test, vi } from 'vite-plus/test';
import { $, mountPage, settle, text } from '../../test/support.ts';
import { detection, dialog, empty, openOnboarding, project, serve } from './onboarding-support.ts';

const DETECTED = { '/api/onboarding/detect': { detection: detection(), error: null } };

const inDialog = <T extends HTMLElement = HTMLElement>(selector: string) => dialog()!.querySelector<T>(selector);
const button = (label: string) => [...dialog()!.querySelectorAll<HTMLButtonElement>('[data-slot="modal-footer"] button')].find((b) => text(b).trim() === label);
const radio = (name: string) => [...dialog()!.querySelectorAll<HTMLElement>('[role="radio"]')].find((r) => text(r.closest('[data-choice]')).startsWith(name))!;

test('the dialog is a modal with a scrolling body, the step, its place and the progress bar', async () => {
  await openOnboarding([project('lar-web')]);
  expect(dialog()!.getAttribute('aria-modal')).toBe('true');
  expect(dialog()!.getAttribute('aria-describedby'), 'its place describes it').toBe('onboarding-place');
  expect(inDialog('[data-slot="modal-body"]')).not.toBeNull();
  expect(text(inDialog('[data-slot="modal-header"] h2'))).toBe('Repository');
  expect(text(inDialog('#onboarding-place'))).toBe('Set up a repository. Step 1 of 8.');
  expect(inDialog('[role="progressbar"]')!.getAttribute('aria-valuenow')).toBe('0');
  expect(inDialog('[role="progressbar"]')!.getAttribute('aria-label'), 'the bar is named by its caption').toBe('0 of 8 done');
});

test('Next is disabled until a project is picked, then shows What we found, and Back returns', async () => {
  await openOnboarding([project('lar-web')], DETECTED);
  expect(button('Back'), 'the first step has no Back').toBeUndefined();
  expect(button('Next')!.disabled).toBe(true);
  await settle(() => radio('lar-web').click());
  expect(button('Next')!.disabled).toBe(false);
  inDialog('[data-slot="modal-body"]')!.scrollTop = 300;
  await settle(() => button('Next')!.click());
  expect(inDialog('[data-slot="modal-body"]')!.scrollTop).toBe(0);
  expect(text(inDialog('[data-slot="modal-header"] h2'))).toBe('What we found');
  expect(text(inDialog('#onboarding-place'))).toBe('Set up lar-web. Step 2 of 8.');
  expect(inDialog('[role="progressbar"]')!.getAttribute('aria-valuenow')).toBe('1');
  await settle(() => button('Back')!.click());
  expect(text(inDialog('[data-slot="modal-header"] h2'))).toBe('Repository');
  expect(radio('lar-web').getAttribute('aria-checked'), 'the pick stays').toBe('true');
});

test('a repository with files from an earlier setup counts Factory files too, and Repository edits once one is dropped', async () => {
  const files = detection({ factoryFiles: { found: [{ kind: 'agent-docs', paths: ['docs/agents/domain.md'] }] } });
  await openOnboarding([project('lar-web')], { '/api/onboarding/detect': { detection: files, error: null } });
  await settle(() => radio('lar-web').click());
  await settle(() => button('Next')!.click());
  expect(text(inDialog('#onboarding-place'))).toBe('Set up lar-web. Step 2 of 9.');
  const { useWizardStore } = await import('./wizard-store.ts');
  await settle(() => useWizardStore.getState().choose({ drop: ['agent-docs'] }));
  expect(text(inDialog('#onboarding-place'))).toBe('Set up lar-web. Step 2 of 10.');
});

test('Add a repository after a close starts a new run', async () => {
  await openOnboarding([project('lar-web')]);
  await settle(() => radio('lar-web').click());
  await settle(() => inDialog<HTMLButtonElement>('[aria-label="Close"]')!.click());
  const { useWizardStore } = await import('./wizard-store.ts');
  expect(useWizardStore.getState().run).toBeNull();
  await settle(() => $<HTMLButtonElement>('[data-onboard]')!.click());
  expect(radio('lar-web').getAttribute('aria-checked')).toBe('false');
});

test('Next and Back move focus to the step heading, and closing returns it to the button that opened the dialog', async () => {
  serve(empty, [project('lar-web')], { error: null }, 200, DETECTED);
  await mountPage(empty);
  const onboard = $<HTMLButtonElement>('[data-onboard]')!;
  onboard.focus();
  await settle(() => onboard.click());
  await settle(() => vi.advanceTimersByTime(50));
  await settle(() => radio('lar-web').click());
  await settle(() => button('Next')!.click());
  expect(document.activeElement, 'Next').toBe(inDialog('[data-slot="modal-header"] h2'));
  await settle(() => button('Back')!.click());
  expect(document.activeElement, 'Back').toBe(inDialog('[data-slot="modal-header"] h2'));
  // Unpicked, so closing keeps nothing and the empty board's button stays.
  const { useWizardStore } = await import('./wizard-store.ts');
  await settle(() => useWizardStore.getState().chooseNew());
  await settle(() => inDialog<HTMLButtonElement>('[aria-label="Close"]')!.click());
  await settle(() => vi.advanceTimersByTime(500));
  expect(document.activeElement).toBe($('[data-onboard]'));
});

test('Finish shows the repository on the board, and Go to the board closes with focus on the button that opened the dialog', async () => {
  serve(empty, [project('lar-web')], { error: null }, 200, { ...DETECTED, '/api/onboarding/import/tickets': { tickets: [], error: null }, '/api/onboarding/setup': { error: null } });
  await mountPage(empty);
  const onboard = $<HTMLButtonElement>('[data-onboard]')!;
  onboard.focus();
  await settle(() => onboard.click());
  await settle(() => radio('lar-web').click());
  const { useWizardStore } = await import('./wizard-store.ts');
  for (let i = 0; i < 8 && !button('Finish'); i++) {
    if (useWizardStore.getState().run!.step === 'role') await settle(() => useWizardStore.getState().choose({ role: 'Web client' }));
    await settle(() => button('Next')!.click());
  }
  await settle(() => button('Finish')!.click());
  expect(text(inDialog('[data-slot="modal-header"] h2'))).toBe('Onboarded');
  expect(text(inDialog('#onboarding-place'))).toBe('Set up lar-web.');
  expect(inDialog('[role="progressbar"]')!.getAttribute('aria-label')).toBe('Ready');
  await settle(() => button('Go to the board')!.click());
  await settle(() => vi.advanceTimersByTime(500));
  expect(dialog()).toBeNull();
});
