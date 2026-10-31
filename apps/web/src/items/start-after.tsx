// Start after, in place of a blocked item's Start: its menu arms the start on a model choice, so the board server
// starts the item once every issue it's blocked by closes. It reads "Starts after #n ✓" until then, and pressing it
// again disarms it. A start the server ran by itself and that failed leaves its error on the item. StartOrAfter is
// the item's Start wherever a start can be blocked: Start after alone while it's blocked.

import { useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { blockerGroups, openBlockerRefs, openBlockers, itemName, ref, startHold, startRequest } from '@lar-factory/shared';
import type { BoardData, Item, ModelChoice } from '@lar-factory/shared';
import { Button } from '@lar-factory/ui/design-system/Button';
import { ICON, kind as buttonKind } from '../buttons/button-kinds.tsx';
import { DropdownMenu } from '@lar-factory/ui/design-system/DropdownMenu';
import { useBoardStore } from '../board/board-store.ts';
import { notify } from '../notices/notices.tsx';
import { DismissButton, closeKeepingFocus } from '../notices/toasts.tsx';
import { postAction, receive } from './card-actions.ts';
import { writeState } from './item-actions.tsx';
import { StartControl, StartEntries, opensOnChecked } from './start-control.tsx';
import type { StartKind } from './start-store.ts';

/** The open blocker Start after names, the last one when several are open, as `#n` or `owner/repo#n`; null once none is. */
const startsAfter = (item: Item, short = false): string | null => openBlockerRefs(item, short).at(-1) ?? null;

/** Lets a Start after button shrink inside its row, its label truncating while its mark stays. */
const SHRINKS = 'min-w-0 max-w-full shrink';

/** What the title says Start after waits for: every open blocker's work, and the user's mark on each unmet Dependency. */
function waitsFor(item: Item): string {
  const { work, dependencies } = blockerGroups(item);
  return [
    ...work ? [`${work.names} ${work.many ? 'complete' : 'completes'}`] : [],
    ...dependencies ? [`you mark ${dependencies.names} met`] : [],
  ].join(' and ');
}

/** Arms the item's start on `choice`, or disarms it with `null`; a refusal shows as a toast. */
async function setArmed(item: Item, choice: ModelChoice | undefined | null): Promise<void> {
  const session = useBoardStore.getState().data.capture?.session;
  const result = choice === null ? await postAction('/api/disarm', { session, itemId: item.id })
    : await postAction('/api/arm', startRequest(session, item.id, choice));
  flushSync(() => {
    receive(result);
    if (result.error) notify({ verb: 'Failed', item, message: result.error });
  });
}

/** Start after #n, or Starts after #n ✓ while armed, a Start. */
function StartAfter({ item, data }: { item: Item; data: BoardData }) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const after = startsAfter(item);
  const label = startsAfter(item, true);
  if (!after) return null;
  const armed = !!data.armed?.[item.id];
  const writes = pending ? { 'aria-disabled': true as const } : writeState(data);
  const held = Boolean(writes['aria-disabled']);
  const run = async (choice: ModelChoice | undefined | null) => {
    setPending(true);
    try { await setArmed(item, choice); } finally { setPending(false); }
  };
  if (armed) {
    return (
      <Button {...buttonKind('start')} leftIcon={ICON.play} className={SHRINKS} data-start-after={item.id} aria-pressed aria-label={`Starts after ${after}`}
        title={`Starts by itself once ${waitsFor(item)}. Pressing it again disarms it`} {...writes}
        onClick={() => !held && void run(null)}><span className="truncate">Starts after {label}</span> ✓</Button>
    );
  }
  const pick = (choice: ModelChoice | undefined) => {
    flushSync(() => setOpen(false));
    void run(choice);
  };
  // Sample mode keeps the menu open-able, so the model choices can be seen; its entries arm nothing.
  return (
    <DropdownMenu open={open && !held} onOpenChange={(next) => setOpen(next && !held)} modal={false}>
      <DropdownMenu.Trigger asChild>
        <Button {...buttonKind('start')} leftIcon={ICON.play} className={SHRINKS} data-start-after={item.id} aria-label={`Start ${itemName(item)} after ${after}`}
          title={`Starts by itself once ${waitsFor(item)}`} {...(data.capture?.enabled === false ? {} : writes)}><span className="truncate">Start after {label}</span> ▾</Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="end" aria-label={`Start ${ref(item)} after ${after} with`} {...opensOnChecked}>
        <StartEntries item={item} data={data} onPick={pick} />
      </DropdownMenu.Content>
    </DropdownMenu>
  );
}

/** Whether StartOrAfter shows Start after: a blocker is open, and its repository holds no start or one is armed. */
export const showsStartAfter = (item: Item, data: BoardData): boolean =>
  openBlockers(item).length > 0 && (!startHold(data, item.repo) || !!data.armed?.[item.id]);

/**
 * The item's Start, the StartControl named `label`, while nothing holds it. An open blocker holds it, and so does its
 * repository, where a refining thread and a build both start, while it is still onboarding or T3 has no project for
 * it. While a blocker holds it, Start after takes its place. While only the repository holds it, Start shows
 * disabled, its title giving the hold's reason; an armed start would fail then, so none is offered, but one armed
 * before the hold still shows while a blocker is open, so it can be disarmed.
 */
export function StartOrAfter({ item, data, label = 'Start', kind = 'refine' }: { item: Item; data: BoardData; label?: string; kind?: StartKind }) {
  if (showsStartAfter(item, data)) return <StartAfter item={item} data={data} />;
  const hold = startHold(data, item.repo);
  if (!hold) return <StartControl item={item} data={data} label={label} kind={kind} />;
  // Pointer events stay on while it's disabled, so its title says why.
  return (
    <Button {...buttonKind('start')} leftIcon={ICON.play} className="disabled:pointer-events-auto" data-start={item.id} disabled title={hold}>
      {label}
    </Button>
  );
}

/** Why the start the board ran by itself failed; dismissing it clears it on the server. */
export function StartAfterError({ item, data }: { item: Item; data: BoardData }) {
  const el = useRef<HTMLParagraphElement>(null);
  const error = data.armedErrors?.[item.id];
  if (!error) return null;
  const id = CSS.escape(item.id);
  const close = () => closeKeepingFocus(el.current, () => void setArmed(item, null), [`[data-start-after="${id}"]`, `[data-start="${id}"]`]);
  return (
    <p className="start" ref={el} data-start-after-error={item.id}>
      <span className="action-error"><span role="alert">Start after failed: {error}</span> <DismissButton what={` Start after error for ${ref(item)}`} onClick={close} /></span>
    </p>
  );
}
