import { PublishButton } from '../publication/publication-dialog.tsx';
// The item dialog: every item, wherever it's listed, opens here over the page, as the design system's workspace-sized
// Modal, whose body fades at its scrolled edges. Under its title it shows the item's repository, status and parent, with
// the agent work figures beside the title. Its body has a progress bar with the slices as an overview, its hint, a meta area of
// people, labels, dates, milestone or iteration and area, then its work record's brief, map or decision, and its ticket's
// description and comments as ticket context; work with no ticket shows its record alone. The work it waits on,
// sub-tickets and pull requests sit in a sidebar beside them when the dialog is 45rem wide, else between the description and the
// comments. Work that needs you shows why above the meta area, with the board's choices for it. The board's fields show at
// once; the description, comments and people load when it opens. Its footer has GitHub, or Azure DevOps for a work
// item, and the one action the item's status asks for, with Back to List and Abandon at its left. Its description has
// Edit, and its header an expand control that grows it, the open editor taking the height. Closing it with unsaved edits
// asks "Discard changes?" first.

import { useEffect, useState, type ReactNode } from 'react';
import { HINTS, blockedText, onAzure, openBlockers, itemName, repoKey, sameRepo, shortAgo } from '@lar-factory/shared';
import type { BoardData, Item } from '@lar-factory/shared';
import type { ItemDetailsRead } from './use-item-details.ts';
import { Button } from '@lar-factory/ui/design-system/Button';
import { Modal } from '@lar-factory/ui/design-system/Modal';
import { useBoardStore } from '../board/board-store.ts';
import { kind } from '../buttons/button-kinds.tsx';
import { EXPANDED, ExpandButton, useExpand } from '../expand-dialog/expand-dialog.tsx';
import { AbandonButton, ActionError, BackToListButton, QueueButton } from '../items/item-actions.tsx';
import { OpenThread, hasLiveThread } from '../items/open-thread.tsx';
import { NeedsYou } from '../items/needs-you.tsx';
import { Dependencies, dependenciesOf } from '../items/dependencies.tsx';
import { PrLink } from '../items/pr-link.tsx';
import { AgentWork, PrList, RepoTag } from '../items/item-parts.tsx';
import { LinkButton } from '../items/link-button.tsx';
import { StartAfterError, StartOrAfter } from '../items/start-after.tsx';
import { StartBuild } from '../items/start-build.tsx';
import { StartMessage, useStartHolds } from '../items/start-control.tsx';
import { StatusGlyph } from '../items/status-glyph.tsx';
import { ItemComments, ItemDescription, ItemMeta, ItemRelations } from './item-details-view.tsx';
import { useItemDialogStore } from './item-dialog-store.ts';
import { useDescriptionEdit } from './use-description-edit.ts';
import type { DescriptionEdit } from './use-description-edit.ts';
import { ItemProgress } from './item-progress.tsx';
import { useItemDetails } from './use-item-details.ts';
import { AttachTicket } from './attach-ticket.tsx';
import { RecordText } from './record-text.tsx';

/** The one thing the item's status asks of you. */
function StatusAction({ item, data }: { item: Item; data: BoardData }) {
  switch (item.status) {
    case 'List': return <QueueButton item={item} data={data} />;
    case 'Queued':
      if (hasLiveThread(item)) return <OpenThread item={item} data={data} />;
      return <StartOrAfter item={item} data={data} label="Start refining" />;
    case 'Ready': return <StartBuild item={item} data={data} />;
    case 'Shaping': case 'In progress': case 'Review': return <OpenThread item={item} data={data} />;
    case 'Needs you': return <OpenThread item={item} data={data} label="Answer in T3" />;
    case 'Verify': return <PrLink item={item} label="Verify build" />;
    case 'Ready to merge': return <PrLink item={item} label="Merge PR" />;
    default: return null;
  }
}

/** Back to List and Abandon; a Start in flight, uncertain or done, or a thread at work on the item, takes them away. */
function MoveActions({ item, data }: { item: Item; data: BoardData }) {
  const startHolds = useStartHolds(item, data);
  if (item.status === 'List') return <AbandonButton item={item} data={data} />;
  if (item.status !== 'Queued' || startHolds || hasLiveThread(item)) return null;
  return <><BackToListButton item={item} data={data} /><AbandonButton item={item} data={data} /></>;
}

/** The work records the item's record waits on, as the board holds them. */
const waitsOn = (item: Item) => item.blockers.filter((b) => b.workId);

/** Whether the sidebar has anything: work it waits on, Dependencies, pull requests, or sub-tickets (as many as the board counts while the details load). */
const hasRelations = (item: Item, read: ItemDetailsRead): boolean =>
  item.linkedPrs.length > 0 || waitsOn(item).length > 0 || dependenciesOf(item).length > 0
  || (read.state === 'loaded' ? (read.details.subTickets.length > 0 || Boolean(read.details.attachments?.length || read.details.related?.length || read.details.blockers?.length || read.details.relationsError)) : read.state === 'loading' && item.subIssues.total > 0);

const Section = ({ heading, children }: { heading: ReactNode; children: ReactNode }) => (
  <section className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2"><h2 className="m-0 text-[13px] font-medium">{heading}</h2>{children}</section>
);

interface ContentProps {
  item: Item;
  data: BoardData;
  now: number;
  read: ItemDetailsRead;
  edit: DescriptionEdit;
  expanded: boolean;
  toggleExpanded: () => void;
}

function ItemDialogContent({ item, data, now, read, edit, expanded, toggleExpanded }: ContentProps) {
  const aside = hasRelations(item, read);
  const record = read.state === 'loaded' ? read.details.record : undefined;
  // Work with no ticket has no ticket text to show beside its record's.
  const ticket = !record || item.number > 0;
  const hint = HINTS[item.status];
  // Saving a description writes the ticket, which waits on this Mac's consent to edit the repository's tickets.
  const editable = data.repos.find((r) => sameRepo(r.repo, item.repo))?.setup?.consent.includes('edit-ticket') ?? false;
  // The open editor in an expanded dialog takes the height the rest leaves.
  const fill = expanded && edit.editing;
  const rows = fill ? 'min-h-0 flex-1 grid-rows-[minmax(0,1fr)_auto]' : aside ? '@min-[45rem]:grid-rows-[auto_1fr]' : '';
  return (
    <Modal.Content title={`${itemName(item)}`} presentation="workspace" data-item-dialog style={expanded ? EXPANDED : undefined}
      headerActions={<>
        <AgentWork item={item} className="whitespace-nowrap text-xs text-base-700 @max-[40rem]:hidden" />
        <ExpandButton expanded={expanded} toggle={toggleExpanded} />
      </>}>
      <div className="@container grid shrink-0 gap-1 border-b border-base-300 px-5 pb-3 text-xs text-base-700 sm:px-6" data-item-summary>
        <div className="flex min-w-0 items-center gap-2 whitespace-nowrap">
          <RepoTag repo={repoKey(item)} repos={data.repos} />
          <StatusGlyph status={item.status} /> <span className="font-medium text-base-content">{item.status}</span>
          <span className="min-w-0 truncate @max-[30rem]:hidden">· updated {shortAgo(item.updatedAt, now)}</span>
          {openBlockers(item).length > 0 && <span className="rounded bg-(--error-surface) px-1.5 text-(--error-foreground)" title={blockedText(item) ?? undefined}>blocked by {openBlockers(item).length}<span className="sr-only">. {blockedText(item)}</span></span>}
        </div>
        {item.parent && <p className="m-0 min-w-0 wrap-anywhere" data-item-parent>Part of {item.parent.url
          ? <a href={item.parent.url} target="_blank" rel="noopener" className="underline">{itemName(item.parent)}</a> : itemName(item.parent)}</p>}
        <AttachTicket item={item} />
      </div>
      <Modal.Body layout={fill ? 'fill' : 'scroll'}>
        {/* Filling, a column whose description and comments take what the rest leave, however many of the rest show. */}
        <div className={`@container gap-3 pt-2 ${fill ? 'flex min-h-0 flex-1 flex-col' : 'grid grid-cols-[minmax(0,1fr)]'}`} data-item-body>
          <ItemProgress item={item} />
          {hint && (
            <div className="flex items-center gap-3 rounded-xl border border-[color-mix(in_srgb,var(--warning)_35%,transparent)] bg-(--warning-surface) px-3 py-2.5">
              <StatusGlyph status={item.status} className="size-4" />
              <span className="min-w-0 flex-1 font-medium text-(--warning-foreground)">{hint}</span>
            </div>
          )}
          {item.paused && <p data-paused className="m-0 rounded-xl border border-[color-mix(in_srgb,var(--warning)_35%,transparent)] bg-(--warning-surface) px-3 py-2.5 font-medium text-(--warning-foreground)">Paused: {item.paused}</p>}
          <NeedsYou item={item} data={data} />
          <ItemMeta item={item} read={read} now={now} />
          <div className={`grid grid-cols-[minmax(0,1fr)] gap-x-6 gap-y-4 ${aside ? '@min-[45rem]:grid-cols-[minmax(0,1fr)_16rem]' : ''} ${rows}`}>
            {record && <RecordText item={item} record={record} className="@min-[45rem]:col-start-1" />}
            {ticket && <ItemDescription read={read} edit={edit} editable={editable} fill={fill} ticketContext={Boolean(record)} className="@min-[45rem]:col-start-1" />}
            {aside && (
              <aside className="grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-4 @min-[45rem]:col-start-2 @min-[45rem]:row-span-2 @min-[45rem]:row-start-1 @min-[45rem]:border-l @min-[45rem]:border-(--border) @min-[45rem]:pl-6">
                {waitsOn(item).length > 0 && <Section heading="Waits on"><ul className="m-0 grid list-none gap-1.5 p-0 text-sm" data-waits-on>
                  {waitsOn(item).map((b) => <li key={b.workId} className={b.state === 'closed' ? 'text-(--muted-foreground) line-through' : ''}>{b.title}</li>)}
                </ul></Section>}
                {dependenciesOf(item).length > 0 && <Section heading="Dependencies"><Dependencies item={item} data={data} now={now} /></Section>}
                <ItemRelations item={item} read={read} />
                {item.linkedPrs.length > 0 && <Section heading="Pull requests"><PrList item={item} /></Section>}
              </aside>
            )}
            {ticket && <ItemComments itemId={item.id} read={read} now={now} ticketContext={Boolean(record)} className="@min-[45rem]:col-start-1" />}
          </div>
          <ActionError item={item} />
          <StartMessage item={item} kind={item.status === 'Ready' ? 'build' : 'refine'} />
          <StartAfterError item={item} data={data} />
        </div>
      </Modal.Body>
      <Modal.Footer leading={<span className="inline-flex items-center gap-3 text-xs"><MoveActions item={item} data={data} /></span>}>
        <span className="inline-flex items-center gap-1.5">
          {item.url && <LinkButton kind="other" href={item.url} target="_blank" rel="noopener">{item.repo && onAzure(item.repo) ? 'Azure DevOps' : 'GitHub'}</LinkButton>}
          <PublishButton item={item} data={data} />
          <StatusAction item={item} data={data} />
        </span>
      </Modal.Footer>
    </Modal.Content>
  );
}

/** Asks before closing the dialog drops unsaved edits to the description. */
function DiscardPrompt({ keep, discard }: { keep: () => void; discard: () => void }) {
  return (
    <Modal onClose={keep}>
      <Modal.Content title="Discard changes?" description="Your edits to the description haven't been saved.">
        <Modal.Footer>
          <Button {...kind('other')} onClick={keep}>Keep editing</Button>
          <Button {...kind('main', 'danger')} onClick={discard}>Discard</Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal>
  );
}

/** The dialog on one item, which holds its details, its description edit and its size until it closes. */
function ItemModal({ item, data, now, close }: { item: Item; data: BoardData; now: number; close: () => void }) {
  const { read, refresh } = useItemDetails(item.id, item.updatedAt);
  const edit = useDescriptionEdit(item.id, read, refresh);
  const [asking, setAsking] = useState(false);
  const [expanded, toggleExpanded] = useExpand(asking);
  return <>
    <Modal onClose={() => (edit.dirty ? setAsking(true) : close())} loading={edit.saving}>
      <ItemDialogContent item={item} data={data} now={now} read={read} edit={edit} expanded={expanded} toggleExpanded={toggleExpanded} />
    </Modal>
    {asking && <DiscardPrompt keep={() => setAsking(false)} discard={() => { setAsking(false); close(); }} />}
  </>;
}

export function ItemDialog() {
  const { data, now } = useBoardStore();
  const { itemId, close } = useItemDialogStore();
  const item = data.items.find((i) => i.id === itemId);
  // An item that left the board closes the dialog for good, so a later read that brings it back doesn't reopen it.
  useEffect(() => {
    if (itemId && !item) close();
  }, [itemId, item, close]);
  if (!item) return null;
  return <ItemModal key={item.id} item={item} data={data} now={now} close={close} />;
}
