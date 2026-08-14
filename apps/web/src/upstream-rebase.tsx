import { useEffect, useRef, useState } from 'react';

export type GitUpstreamSummary = { upstream: string; ahead: number; behind: number };

// offer the existing agent workflow when upstream contains new commits
export function UpstreamRebaseBanner({ summary, onRebase }: { summary?: GitUpstreamSummary; onRebase?: () => Promise<boolean> }) {
  const [queueing, setQueueing] = useState(false);
  const [queued, setQueued] = useState(false);
  const queuedTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => {
    if (queuedTimer.current !== undefined) window.clearTimeout(queuedTimer.current);
  }, []);
  if (summary === undefined || summary.behind === 0) return null;
  const commits = `${summary.behind} new ${summary.behind === 1 ? 'commit' : 'commits'}`;
  const local = summary.ahead === 0 ? '' : ` Your branch also has ${summary.ahead} local ${summary.ahead === 1 ? 'commit' : 'commits'}.`;
  const queueRebase = async () => {
    if (onRebase === undefined || queueing) return;
    setQueueing(true);
    try {
      if (!await onRebase()) return;
      setQueued(true);
      if (queuedTimer.current !== undefined) window.clearTimeout(queuedTimer.current);
      queuedTimer.current = window.setTimeout(() => {
        queuedTimer.current = undefined;
        setQueued(false);
      }, 1_600);
    } finally { setQueueing(false); }
  };
  return <section className="upstream-rebase-banner" role="status" aria-label={`${summary.upstream} has ${commits}`}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3v12m0 0-3-3m3 3 3-3M18 21V9m0 0-3 3m3-3 3 3M9 5h5a4 4 0 0 1 4 4M15 19h-5a4 4 0 0 1-4-4" /></svg><span><strong>Upstream updates available</strong><small>{summary.upstream} has {commits}.{local}</small></span><button className={queued ? 'queued' : undefined} type="button" disabled={onRebase === undefined || queueing} aria-label={`Rebase onto ${summary.upstream}`} title={onRebase === undefined ? 'Launch the agent to rebase upstream' : `Queue $rebase ${summary.upstream}`} onClick={() => void queueRebase()}>{queueing ? <span className="spinner" /> : queued ? '✓ Queued' : 'Rebase upstream'}</button></section>;
}
