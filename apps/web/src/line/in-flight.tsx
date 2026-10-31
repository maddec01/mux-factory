// Everything else in flight: every item past the Queue and short of Done that no dossier shows, furthest along first.
// Each row reads as a collapsed dossier on the same two lines and line 2 columns, so its slice bar sits under a
// dossier's part bar: line 1 the status glyph, title and meta, line 2 a build's slice bar, slice count, first blocked or
// active slice and the agent figures, with the side action across both lines. Ready items keep Start build here as well
// as on the desk. Items in Needs you, Verify or Ready to merge show where they are but take no action here: you act on
// them from the desk.

import { useState } from 'react';
import type { ReactNode } from 'react';
import { ChevronDown, ChevronRight, GitPullRequest } from 'lucide-react';
import { blockedText, itemName, openBlockers, prLabel, repoKey, repoName } from '@lar-factory/shared';
import type { BoardData, Item } from '@lar-factory/shared';
import { Badge } from '@lar-factory/ui/design-system/Badge';
import { useBoardStore } from '../board/board-store.ts';
import { useItemDialogStore } from '../item-dialog/item-dialog-store.ts';
import { AzureFields, ItemTitle, SliceBar, SliceList } from '../items/item-parts.tsx';
import { KeepClicks } from '../items/keep-clicks.tsx';
import { OpenThread } from '../items/open-thread.tsx';
import { StartBuild } from '../items/start-build.tsx';
import { StartAfterError } from '../items/start-after.tsx';
import { StartMessage } from '../items/start-control.tsx';
import { StatusGlyph } from '../items/status-glyph.tsx';
import { HEAD_A1, LINE2_A1, Figures, figuresOf } from './columns.tsx';
import { dossiersOf, inDossiers } from './dossier-parts.ts';
import { OnYourDesk, YOURS, picked, stageOf, threadText } from './stage-track.tsx';

/** A button that doesn't open the item underneath it, nor do clicks in the menu it opens. */
function Act({ children }: { children: ReactNode }) {
  return <KeepClicks as="span" className="min-w-0 max-w-full">{children}</KeepClicks>;
}

/** The one thing a status asks next, or where to act on an item that waits on you. */
function Side({ item, data }: { item: Item; data: BoardData }) {
  if (YOURS.includes(item.status)) return <OnYourDesk status={item.status} />;
  switch (item.status) {
    case 'Ready': return <Act><StartBuild item={item} data={data} /></Act>;
    case 'Shaping': case 'In progress': case 'Review': return <Act><OpenThread item={item} data={data} /></Act>;
    default: return null;
  }
}

/** The blocked slices, then the active ones. */
const sliceNote = (item: Item) => {
  const b = item.slices.filter((s) => s.progress === 'blocked');
  const a = item.slices.filter((s) => s.progress === 'active');
  return [...b.map((s) => ({ s, word: 'blocked', tone: 'text-(--st-review)' })), ...a.map((s) => ({ s, word: 'active', tone: 'text-(--st-now)' }))];
};

/** One item; the whole row opens it in the item dialog, and a build's slice count unfolds its slices under it. */
function FlightRow({ item, data }: { item: Item; data: BoardData }) {
  const done = item.slices.filter((s) => s.progress === 'done').length;
  const note = sliceNote(item);
  const blocked = openBlockers(item).length;
  const repo = repoName(repoKey(item), data.repos);
  const [slices, setSlices] = useState(false);
  const isPicked = useItemDialogStore((state) => state.itemId === item.id);
  return (
    <div className="border-b border-(--border) last:border-b-0" data-flight={item.id}>
      <div onClick={() => useItemDialogStore.getState().open(item.id)} data-item={item.id} className={`${HEAD_A1} cursor-pointer hover:bg-(--accent) ${picked(isPicked)}`}>
        <span className="grid size-6 place-items-center" data-glyph><StatusGlyph status={item.status} /></span>
        {/* Line 1 spans line 2's first four columns; the side action takes the repositories column across both lines.
            Below 1024 px, where a dossier drops that column, line 1 spans three and the action sits above the figures. */}
        <span className={`grid ${LINE2_A1} items-center gap-x-4 gap-y-1`} data-line2>
          <span className="col-span-3 flex min-w-0 lg:col-span-4 flex-wrap items-baseline gap-x-2 gap-y-0.5 pt-0.5" data-line="1">
            <span className="line-clamp-2 text-[13px] font-medium" title={item.title} data-title><ItemTitle item={item} /></span>
            <span className="inline-flex flex-wrap items-center gap-x-1.5 text-[11px] text-(--muted-foreground)" data-meta>
              <span>{item.status} · {threadText(item)} · {repo}</span>
              {item.linkedPrs[0] && <span className="inline-flex items-center gap-1"><GitPullRequest className="size-3 text-(--st-done)" />{prLabel(item.linkedPrs[0])}</span>}
              {blocked > 0 && <Badge tone="danger" title={blockedText(item) ?? undefined}>blocked by {blocked}<span className="sr-only">. {blockedText(item)}</span></Badge>}
              <AzureFields azure={item.azure} />
            </span>
          </span>
          <span data-col="side" className="col-start-4 row-start-1 flex lg:col-start-5 lg:row-span-2 min-w-0 flex-wrap items-center justify-end gap-x-2 gap-y-1 self-center text-right text-[11px] text-(--muted-foreground)"><Side item={item} data={data} /></span>
          <span data-col="bar">{item.slices.length ? <SliceBar item={item} thick /> : null}</span>
          {item.slices.length ? (
            <button type="button" aria-expanded={slices} aria-label={slices ? 'Hide slices' : 'Show slices'} onClick={(e) => { e.stopPropagation(); setSlices(!slices); }} data-col="count"
              className="-ml-1 flex h-4 items-center gap-0.5 justify-self-start rounded px-1 text-[11px] tabular-nums text-(--muted-foreground) hover:bg-(--soft) hover:text-(--foreground)">
              {done}/{item.slices.length} slices{slices ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            </button>
          ) : <span className="h-4" data-col="count" />}
          <span data-col="next" className="min-w-0 truncate text-[12px] leading-4" title={note.map(({ s, word }) => `${word} ${itemName(s)}`).join('\n')}>
            {note[0] && <><span className={`font-medium ${note[0].tone}`}>{note[0].word}</span> {note[0].s.title}{note.length > 1 && <span className="text-(--muted-foreground)"> +{note.length - 1} more</span>}</>}
          </span>
          <span data-col="figures" className="grid min-w-0"><Figures s={figuresOf(item, data)} /></span>
        </span>
      </div>
      {item.status === 'Ready' && <KeepClicks className="pb-2 pl-10 pr-2 empty:hidden"><StartMessage item={item} kind="build" /><StartAfterError item={item} data={data} /></KeepClicks>}
      {slices && <div className="pb-2 pl-10 pr-2" data-slices><SliceList item={item} /></div>}
    </div>
  );
}

/** `items` are the line's items in the main area's scope; those a dossier shows are left out. */
export function InFlight({ items }: { items: Item[] }) {
  const { data } = useBoardStore();
  const shown = inDossiers(dossiersOf(items, data.items));
  const rows = items.filter((i) => stageOf(i.status) >= 0 && i.status !== 'Done' && !shown.has(i.id)).sort((a, b) => stageOf(b.status) - stageOf(a.status));
  return (
    <div className="overflow-hidden rounded-xl border border-(--border) bg-(--card)" data-in-flight>
      <div className="border-b border-(--border) px-3 py-1.5 text-[11px] font-medium text-(--muted-foreground)" data-in-flight-title>Everything else in flight · {rows.length}</div>
      {rows.length ? rows.map((i) => <FlightRow key={i.id} item={i} data={data} />) : <p className="m-0 p-6 text-center text-(--muted-foreground)">Nothing else in flight.</p>}
    </div>
  );
}
