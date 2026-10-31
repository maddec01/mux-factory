import { useState } from 'react';
import { Button } from '@lar-factory/ui/design-system/Button';
import { Input } from '@lar-factory/ui/design-system/Input';
import { Textarea } from '@lar-factory/ui/design-system/Textarea';
import { Field } from '../onboarding/setup-fields.tsx';
import { kind } from '../buttons/button-kinds.tsx';
import { usePublicationStore } from './publication-store.ts';

export function PublicationHandover() {
  const { state, workId } = usePublicationStore();
  const [message, setMessage] = useState('');
  if (!state?.handover) return null;
  const copy = async () => {
    try { await navigator.clipboard.writeText(state.handover!); setMessage('Copied the complete markdown handover.'); }
    catch { setMessage('Could not copy. Select the handover text below or download it.'); }
  };
  return <section className="grid min-w-0 gap-3" aria-label="Markdown handover">
    <h3 className="m-0 text-sm font-medium">Markdown handover</h3>
    <p className="m-0 text-sm">Copy or download the complete team content. Cost: you post it yourself. Refused write access does not block this handover.</p>
    <div className="flex flex-wrap items-center gap-3">
      <Button {...kind('other')} onClick={() => void copy()}>Copy markdown handover</Button>
      <a className="text-sm underline" download={`refinement-${workId}.md`} href={`data:text/markdown;charset=utf-8,${encodeURIComponent(state.handover)}`}>Download markdown handover</a>
    </div>
    {message && <p role="status" className="m-0 text-sm">{message}</p>}
    <Textarea aria-label="Complete markdown handover" readOnly value={state.handover} />
    {state.pending!.plan.tickets.filter((ticket) => !ticket.dependencyOf).map((ticket) => <PublicationAttachment key={ticket.workId} targetWorkId={ticket.workId} title={ticket.title} />)}
  </section>;
}

function PublicationAttachment({ targetWorkId, title }: { targetWorkId: string; title: string }) {
  const { state, busy, request } = usePublicationStore();
  const [url, setUrl] = useState('');
  const attachment = state!.attachments?.find((item) => item.workId === targetWorkId);
  if (attachment) return <p className="m-0 text-sm">Attached to the same local work: <a className="underline" href={attachment.url} target="_blank" rel="noopener">{attachment.ticket}</a></p>;
  // Uncertain creations must be reconciled before an ordinary attachment can be considered.
  if (state!.pending!.uncertain.length) return null;
  const resolved = state!.resolvedUrl?.workId === targetWorkId && state!.resolvedUrl.url === url ? state!.resolvedUrl : null;
  return <section className="grid min-w-0 gap-2" aria-label={`Attach posted URL for ${title}`}>
    <Field label={`Posted ticket URL for ${title}`} hint="After posting, inspect its destination and attach it to this same work.">{(props) => <Input {...props} type="url" value={url} disabled={busy} onChange={(e) => setUrl(e.target.value)} />}</Field>
    <span><Button {...kind('other')} disabled={busy || !url.trim()} onClick={() => void request('resolve-url', { targetWorkId, url })}>Inspect posted URL</Button></span>
    {resolved && <>
      <p className="m-0 text-sm">Resolved destination: <a href={resolved.url} target="_blank" rel="noopener" className="underline">{resolved.ticket}</a></p>
      <pre className="m-0 whitespace-pre-wrap break-words text-xs">{resolved.body}</pre>
      <span><Button {...kind('main')} disabled={busy} onClick={() => void request('attach-url', { targetWorkId, url, revision: resolved.revision })}>Attach inspected URL to this work</Button></span>
    </>}
  </section>;
}
