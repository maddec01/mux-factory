import { publicationConsents, publicationWriteTicket, sameRepo } from '@lar-factory/shared';
import { useBoardStore } from '../board/board-store.ts';
import { Button } from '@lar-factory/ui/design-system/Button';
import { Alert } from '@lar-factory/ui/design-system/Alert';
import { kind } from '../buttons/button-kinds.tsx';
import { usePublicationStore } from './publication-store.ts';
import { PublicationHandover } from './publication-handover.tsx';
import { PublicationRecovery } from './publication-recovery.tsx';

function PublicationTextDiff({ before, after }: { before: string; after: string }) {
  const previous = before.split(/(?<=\n)/); const next = after.split(/(?<=\n)/);
  let start = 0; let end = 0;
  while (start < Math.min(previous.length, next.length) && previous[start] === next[start]) start++;
  while (end < Math.min(previous.length, next.length) - start && previous[previous.length - end - 1] === next[next.length - end - 1]) end++;
  return <div className="grid min-w-0 gap-1">
    <p className="m-0 text-xs">Text diff. Removed text is struck through. Added text is underlined.</p>
    <pre className="m-0 whitespace-pre-wrap break-words text-sm" data-publication-diff>{previous.slice(0, start).join('')}<del>{previous.slice(start, previous.length - end).join('')}</del><ins>{next.slice(start, next.length - end).join('')}</ins>{end ? previous.slice(-end).join('') : ''}</pre>
  </div>;
}

/** Exact text is shown as text, including markup. Nothing executes from a preview. */
export function PublicationPreview() {
  const { state, busy, needsInspection, request, setMode } = usePublicationStore();
  const pending = state!.pending!;
  const { plan } = pending;
  const items = useBoardStore((store) => store.data.items);
  const changed = state!.sources.some((source) => {
    const item = items.find((item) => item.id === source.workId);
    return item && item.revision !== source.revision;
  });
  const reasons = pending.reasons.filter((reason) => reason !== 'The exact publication content needs approval.');
  const completed = plan.operations.length === 0 || plan.approval && plan.results.every((result) => result.status === 'successful');
  const name = (workId: string) => plan.tickets.find((ticket) => ticket.workId === workId)?.title ?? 'Ticket';
  return <div className="grid min-w-0 gap-4" data-publication-preview>
    {changed && <Alert tone="warning" title="The work changed">Refresh the journal before approving this preview.</Alert>}
    {needsInspection && <Alert tone="warning" title="Inspect the stored outcome">Refresh the journal before approving or retrying. The provider may have completed the previous request.</Alert>}
    {reasons.length > 0 && <Alert tone="warning" title="Review before continuing">{reasons.join(' ')}</Alert>}
    {plan.tickets.map((ticket) => <section key={ticket.workId} className="grid min-w-0 gap-2 rounded-lg border border-base-300 p-3" data-publication-ticket>
      <h3 className="m-0 text-sm font-medium">{ticket.title}</h3>
      {ticket.dependencyOf && <p className="m-0 text-xs" data-dependency-request>Request for the team that owns a Dependency. {plan.operations.some((operation) => operation.ticketWorkId === ticket.workId)
        ? 'Their ticket gets this request once. Later corrections become handover text you send yourself.'
        : ticket.destination.ticket ? 'Their ticket is never changed. Send this text to the team yourself.' : 'Handover only. Send this request to the team yourself.'}</p>}
      <p className="m-0 text-xs">{ticket.destination.provider === 'azure' ? 'Azure DevOps' : 'GitHub'} · {ticket.destination.repository}{ticket.destination.project ? ` · ${ticket.destination.project}` : ''}{ticket.destination.ticket ? ` · ${ticket.destination.ticket}` : ' · New ticket'}</p>
      <p className="m-0 text-xs">Effective type: {ticket.typeResolution.selected ?? 'none'}. Labels or tags: {[...new Set(Object.values(ticket.vocabulary).flatMap((term) => term.labels))].join(', ') || 'none'}.</p>
      <ul className="m-0 pl-5 text-xs">{Object.entries(ticket.vocabulary).map(([term, mapping]) => <li key={term}>{term}: {mapping.type ?? 'no type'}; {mapping.labels.join(', ') || 'no labels or tags'}</li>)}</ul>
      <pre className="m-0 whitespace-pre-wrap break-words text-sm" data-exact-ticket-content>{ticket.body}</pre>
    </section>)}
    <section className="grid gap-2"><h3 className="m-0 text-sm font-medium">Operations in order</h3>
      {plan.operations.length === 0 && <p className="m-0 text-sm">No provider writes. Keep this content as a handover.</p>}
      <ol className="m-0 grid gap-3 pl-5 text-sm">{plan.operations.map((operation) => {
        const ticket = plan.tickets.find((ticket) => ticket.workId === operation.ticketWorkId)!;
        const writeTicket = publicationWriteTicket(operation, plan.tickets);
        const setup = state!.settings.find((config) => sameRepo(config.setup.repo, writeTicket.destination.repository))?.setup;
        return <li key={operation.operationId} data-publication-operation>
        {operation.kind} · {name(operation.ticketWorkId)}{'relatedWorkId' in operation ? ` · ${operation.relationship} ${name(operation.relatedWorkId)}` : ''}
        <p className="m-0 text-xs">{plan.results.find((result) => result.operation.operationId === operation.operationId)?.status === 'successful' ? 'Completed. This operation will not repeat.' : 'Remaining write. Approve this exact operation before it runs.'}</p>
        {operation.kind === 'relationship' && plan.tickets.find((item) => item.workId === operation.relatedWorkId)?.dependencyOf && <p className="m-0 text-xs" data-dependency-link>Links this ticket to the team's ticket. If the provider refuses, a fallback previews a "Depends on" line for separate approval. A refusal keeps the local blocker and the handover.</p>}
        {!setup && writeTicket.dependencyOf && <p className="m-0 text-xs">Write repository: {writeTicket.destination.repository}. It isn't onboarded, so it has no saved permissions or terms. Approving this exact plan is the only permission. If the login can't write there, use the handover.</p>}
        {setup && <p className="m-0 text-xs">Write repository: {writeTicket.destination.repository}. Permissions: {publicationConsents(operation, ticket).map((op) => `${op}: ${setup.access[op] === 'refused' ? 'Refused by the saved credential check' : setup.consent.includes(op) ? 'allowed locally' : 'off on this Mac'}`).join('; ')}.</p>}
        {'pullRequest' in operation && <p className="m-0 text-xs">Delivery PR: {operation.pullRequest}</p>}
        {'expected' in operation && operation.expected && <>
          <p className="m-0 text-xs">Original description, preserved outside the selected range</p>
          <pre className="m-0 whitespace-pre-wrap break-words text-sm" data-original-description>{operation.expected.body}</pre>
          {operation.expected.format === 'html' && <Alert tone="warning" title="Azure HTML preservation">HTML stays in its original format, including colours and merged cells. The refined addition uses escaped text. No Markdown conversion occurs.</Alert>}
          <p className="m-0 text-xs">{ticket.destination.provider === 'azure' ? 'Azure tests the recorded revision before updating this field. Its PATCH uses the login\'s default tenant.' : 'GitHub has no atomic revision check for this edit. A teammate can edit between the final read and write.'} Choose a new comment or handover if this limit is unacceptable.</p>
        </>}
        {'expectedText' in operation && <><p className="m-0 text-xs">Exact last-published text to replace</p><pre className="m-0 whitespace-pre-wrap break-words text-sm" data-publication-before>{operation.expectedText || 'None. Append only.'}</pre></>}
        {'expectedText' in operation && <PublicationTextDiff before={operation.expectedText} after={operation.content} />}
        {'content' in operation && <><p className="m-0 text-xs">{operation.kind === 'comment' && operation.purpose === 'notice' ? 'Exact update notice' : 'Exact refined addition or replacement'}</p><pre className="m-0 whitespace-pre-wrap break-words text-sm" data-refined-addition>{operation.content}</pre></>}
        {'location' in operation && <p className="m-0 text-xs">Location: {operation.location.kind}{operation.location.kind === 'body' ? ` ${operation.location.start} to ${operation.location.end}${operation.location.field ? ` in ${operation.location.field}` : ''}` : ` ${operation.location.commentId}`}</p>}
        {operation.kind === 'replace-comment' && <p className="m-0 text-xs">This provider has no atomic revision check for comment edits. A teammate can edit between the final read and write. Choose a new comment or handover if that limit is unacceptable.</p>}
      </li>; })}</ol>
    </section>
    {(['successful', 'failed', 'uncertain'] as const).map((status) => {
      const results = plan.results.filter((result) => result.status === status);
      return results.length > 0 && <section key={status} data-publication-result={status}><h3 className="m-0 text-sm font-medium">{status === 'successful' ? 'Completed' : status === 'failed' ? 'Failed' : 'Uncertain'}</h3>
        <ul className="m-0 grid gap-1 pl-5 text-sm">{results.map((result) => <li key={result.operation.operationId}>
          {result.operation.kind} · {name(result.operation.ticketWorkId)}
          {result.status === 'failed' && /refus|permission|unsupported/i.test(result.attempt?.evidence ?? '') && <span> · Refused</span>}
          {result.attempt?.url && <a className="ml-2 underline" href={result.attempt.url} target="_blank" rel="noopener">{result.attempt.ticket ?? 'Open ticket'}</a>}
          {result.attempt?.evidence && <p className="m-0 text-xs">{result.attempt.evidence}</p>}
        </li>)}</ul>
      </section>;
    })}
    {state!.history?.filter((previous) => previous.results.some((result) => result.status !== 'pending')).map((previous) => <section key={previous.planId} data-publication-history>
      <h3 className="m-0 text-sm font-medium">Earlier publication outcomes</h3>
      <ul className="m-0 pl-5 text-sm">{previous.results.filter((result) => result.status !== 'pending').map((result) => <li key={result.operation.operationId}>{result.status} · {result.operation.kind} · {result.attempt?.evidence}
        {result.attempt?.url && <a className="ml-2 underline" href={result.attempt.url} target="_blank" rel="noopener">Inspect ticket</a>}
      </li>)}</ul>
    </section>)}
    <PublicationRecovery />
    <PublicationHandover />
    <div className="flex flex-wrap gap-2">
      {!plan.approval && !completed && <Button {...kind('main')} disabled={busy || needsInspection || changed || reasons.length > 0} onClick={() => void request('approve')}>Approve publication</Button>}
      {plan.approval && !completed && pending.current && pending.next && <Button {...kind('main')} disabled={busy} onClick={() => void request('resume')}>Continue approved operations</Button>}
      <Button {...kind('other')} disabled={busy} onClick={() => void request('inspect')}>Refresh journal</Button>
      {!plan.approval && <Button {...kind('other')} disabled={busy} onClick={() => setMode('setup')}>Review Vocabulary and access</Button>}
      {!pending.uncertain.length && !completed && reasons.length > 0 && <Button {...kind('other')} disabled={busy} onClick={() => setMode('edit')}>Revise publication</Button>}
      {!pending.uncertain.length && pending.failed.length > 0 && <><Button {...kind('other')} disabled={busy || changed} onClick={() => void request('retry')}>Preview retry of remaining writes</Button><span className="text-xs">Cost: repeats only failed writes after a new exact approval. Completed operations are skipped.</span></>}
      {!pending.uncertain.length && plan.results.some((result) => (['append', 'replace', 'replace-comment', 'comment', 'textual-relationship'].includes(result.operation.kind) && result.status === 'failed') || result.operation.kind === 'relationship' && ['failed', 'pending'].includes(result.status)) && <>
        <Button {...kind('other')} disabled={busy} onClick={() => void request('fallback')}>Preview fallback</Button>
        <span className="text-xs">Cost: replaces refused native links or body edits with exact comments for separate approval. A refused comment needs manual handover.</span>
      </>}
      {!pending.uncertain.length && !completed && plan.results.some((result) => result.status !== 'successful' && result.operation.kind !== 'pr-closing-reference') && <>
        {plan.results.some((result) => result.status !== 'successful' && ['append', 'replace', 'replace-comment'].includes(result.operation.kind)) && <Button {...kind('other')} disabled={busy} onClick={() => void request('fallback', { delivery: 'comment' })}>Preview new comment</Button>}
        <span className="text-xs">Cost: posts a separately approved comment and leaves the description intact.</span>
        <Button {...kind('other')} disabled={busy} onClick={() => void request('fallback', { delivery: 'handover' })}>Preview markdown handover</Button>
        <span className="text-xs">Cost: you post the content yourself. No provider write.</span>
      </>}
      {!pending.uncertain.length && <Button {...kind('other')} disabled={busy} onClick={() => setMode('edit')}>{completed ? 'Prepare later update' : 'Edit content and prepare again'}</Button>}
    </div>
  </div>;
}
