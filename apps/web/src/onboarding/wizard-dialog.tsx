// The onboarding dialog: the copied Modal over the board, showing one step at a time with a progress bar, Back and Next,
// and Finish on the last step. The empty board, an offer and Resume open it; closing it drops the run until a T3 project
// is picked, or an offered run until Next or a change, then keeps it to resume. Once Finish saves, it says so, with Go to the board.

import { useEffect, useRef } from 'react';
import { ArrowRight, Check } from 'lucide-react';
import { shownRepo } from '@lar-factory/shared';
import { Button } from '@lar-factory/ui/design-system/Button';
import { Modal } from '@lar-factory/ui/design-system/Modal';
import { Text } from '@lar-factory/ui/design-system/Typography';
import { Progress } from '@lar-factory/ui/progress';
import { StepBody } from './steps.tsx';
import { STEP_TITLES, type StepId } from './wizard-choices.ts';
import { type Run, pickedProject, runSteps, stepReady, useWizardStore } from './wizard-store.ts';
import { kind } from '../buttons/button-kinds.tsx';

const STEP_HELP: Record<StepId, string> = {
  project: 'Choose the repository folder where agents will work.',
  detect: 'Read from the repository and your access, with no test write. Nothing here is a question.',
  source: "Choose the team whose work the board shows.",
  import: 'Ticked tickets with a status label or tag become private work with that Status. Their labels and tags stay as they are.',
  role: 'Say what this repository is to the others, such as the API server a client app uses.',
  connections: 'Tick the other onboarded repositories this one works with, so refinement can propose work across them.',
  consent: 'Choose what the factory may write for you, within what your access allows.',
  docs: 'Choose where the glossary and ADRs that builds write go.',
  skills: "Choose the repository's skills that guide how builds write code.",
  files: 'This repository has files from an earlier Lar Factory setup. Keep or drop each one.',
  edits: 'Review the pull request that drops the files you unticked.',
};

/**
 * Where focus goes when the dialog closes and the copied Modal found nowhere to return it: the button that opened it;
 * once that's gone, as the Resume of a repository the dialog finished, the page's main heading.
 */
function closedFocus(opener: HTMLElement | null): HTMLElement | null {
  if (opener?.isConnected) return opener;
  return document.querySelector<HTMLElement>('.title-bar h1');
}

/** Back, then Next, or on the last step Finish; once Finish saved, Go to the board. */
function Nav({ run }: { run: Run }) {
  const { projects, detection, tickets, changes, approved, finish, next, back, save, close } = useWizardStore();
  if (finish.state === 'done') return <Button {...kind('main')} leftIcon={<Check />} onClick={close}>Go to the board</Button>;
  const steps = runSteps(run, detection);
  const at = steps.indexOf(run.step);
  const ready = stepReady(run, projects, detection, tickets, changes, approved);
  return (
    <>
      {at > 0 && <Button {...kind('other')} disabled={finish.state === 'saving'} onClick={back}>Back</Button>}
      {at === steps.length - 1
        ? <Button {...kind('main')} disabled={!ready} loading={finish.state === 'saving'} leftIcon={<Check />} onClick={() => void save()}>Finish</Button>
        : <Button {...kind('main')} disabled={!ready} loading={!!tickets?.importing} rightIcon={<ArrowRight />} onClick={() => void next()}>Next</Button>}
    </>
  );
}

/** The step's heading in the copied Modal's header, which takes focus without being a Tab stop. */
function stepHeading(dialog: HTMLElement | null): HTMLElement | null {
  const heading = dialog?.querySelector<HTMLElement>('[data-slot="modal-header"] h2') ?? null;
  if (heading) {
    heading.tabIndex = -1;
    heading.classList.add('outline-none');
  }
  return heading;
}

/** The dialog while a run is open: the step's title, its place and the progress bar, the step, then Back and Next. */
function WizardModal({ run }: { run: Run }) {
  const { projects, detection, finish, close } = useWizardStore();
  const dialog = useRef<HTMLDivElement>(null);
  const shown = useRef<string | null>(null);
  const finished = finish.state === 'done';
  const place = finished ? 'done' : run.step;
  useEffect(() => {
    const moved = place !== shown.current;
    shown.current = place;
    // Opening, a new step, or a button such as Retry that went away with this render, puts focus on the step's heading, not the page.
    if (moved) {
      const body = dialog.current?.querySelector<HTMLElement>('[data-slot="modal-body"]');
      if (body) body.scrollTop = 0;
    }
    if (moved || document.activeElement === document.body) stepHeading(dialog.current)?.focus();
  });
  const steps = runSteps(run, detection);
  const at = steps.indexOf(run.step);
  const doneCount = finished ? steps.length : at;
  const done = finished ? 'Ready' : `${doneCount} of ${steps.length} done`;
  return (
    <Modal onClose={close}>
      {/* ninna-ui's Modal drops the description from aria-describedby, so the step's place names itself. */}
      <Modal.Content ref={dialog} data-onboarding-dialog title={finished ? 'Onboarded' : STEP_TITLES[run.step]} aria-describedby="onboarding-place"
        description={finished ? undefined : STEP_HELP[run.step]} focusFirstField={false}>
        <div className="grid shrink-0 gap-2 px-5 pb-4 sm:px-6">
          <Text id="onboarding-place" tone="muted">
            Set up {pickedProject(run, projects)?.name ?? (run.repo && shownRepo(run.repo).split('/').at(-1)) ?? 'a repository'}.{!finished && ` Step ${at + 1} of ${steps.length}.`}
          </Text>
          <Progress value={doneCount} max={steps.length} caption={done} aria-label={done} />
        </div>
        <Modal.Body><StepBody run={run} /></Modal.Body>
        <Modal.Footer><Nav run={run} /></Modal.Footer>
      </Modal.Content>
    </Modal>
  );
}

export function WizardDialog() {
  const run = useWizardStore((state) => state.run);
  const opener = useWizardStore((state) => state.opener);
  const open = run !== null;
  const wasOpen = useRef(false);
  useEffect(() => {
    const closed = wasOpen.current && !open;
    wasOpen.current = open;
    if (!closed) return;
    // The copied Modal returns focus on the next task when the element that had it is still on the page.
    const timer = setTimeout(() => { if (document.activeElement === document.body) closedFocus(opener)?.focus(); });
    return () => clearTimeout(timer);
  }, [open, opener]);
  return run && <WizardModal run={run} />;
}
