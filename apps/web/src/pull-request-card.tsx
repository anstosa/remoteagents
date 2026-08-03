import { useEffect, useRef, useState } from 'react';

export type PullRequestIssues = { mergeConflicts?: boolean; failingChecks?: boolean; unresolvedComments?: boolean };
export type PullRequestCheckStatus = 'passed' | 'pending' | 'failed';
export type PullRequestSummary = { number: number; title: string; status: 'draft' | 'open' | 'merged'; url: string; checks?: PullRequestCheckStatus; issues?: PullRequestIssues };

const statusLabel = { draft: 'Draft', open: 'Open', merged: 'Merged' } as const;
type IssueName = keyof PullRequestIssues;
type DisplayIssueName = Exclude<IssueName, 'failingChecks'>;
const issueLabels: Record<IssueName, string> = { mergeConflicts: 'Merge conflicts', failingChecks: 'Failing checks', unresolvedComments: 'Unresolved review comments' };
const checkLabels: Record<PullRequestCheckStatus, string> = { passed: 'CI checks passed', pending: 'CI checks running', failed: 'CI checks failed' };

export function PullRequestStatusIcon({ status, className = '' }: { status: PullRequestSummary['status']; className?: string }) {
  return <i className={`pull-request-status-icon status-${status}${className ? ` ${className}` : ''}`} aria-hidden="true" />;
}

function CheckStatusIcon({ status }: { status: PullRequestCheckStatus }) {
  const shape = status === 'passed'
    ? <path d="m5 12 4 4L19 6" />
    : status === 'pending'
      ? <circle cx="12" cy="12" r="7" />
      : <path d="M7 7l10 10M17 7 7 17" />;
  return <i className={`pull-request-checks checks-${status}`} role="img" aria-label={checkLabels[status]} title={checkLabels[status]}><svg viewBox="0 0 24 24" aria-hidden="true">{shape}</svg></i>;
}

function IssueIcon({ issue }: { issue: DisplayIssueName }) {
  const path = issue === 'mergeConflicts'
    ? 'M6 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm12 12a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM6 9v3a6 6 0 0 0 6 6h3M6 9v12'
    : 'M5 5h14v10H9l-4 4V5Zm4 4h6m-6 3h4';
  return <i className={`pull-request-issue issue-${issue}`} role="img" aria-label={issueLabels[issue]} title={issueLabels[issue]}><svg viewBox="0 0 24 24" aria-hidden="true"><path d={path} /></svg></i>;
}

export function PullRequestIndicators({ checks, issues: issueFlags }: Pick<PullRequestSummary, 'checks' | 'issues'>) {
  const issueNames = (Object.keys(issueFlags ?? {}) as IssueName[]).filter(issue => issueFlags?.[issue] === true);
  const issues = issueNames.filter((issue): issue is DisplayIssueName => issue !== 'failingChecks');
  const checkStatus = checks ?? (issueFlags?.failingChecks === true ? 'failed' : 'pending');
  return <span className="pull-request-issues" aria-label="Pull request status"><CheckStatusIcon status={checkStatus} />{issues.map(issue => <IssueIcon key={issue} issue={issue} />)}</span>;
}

export function PullRequestCard({ pullRequest, onFixup }: { pullRequest?: PullRequestSummary; onFixup?: () => Promise<boolean> }) {
  const [queueing, setQueueing] = useState(false);
  const [queued, setQueued] = useState(false);
  const queuedTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => {
    if (queuedTimer.current !== undefined) window.clearTimeout(queuedTimer.current);
  }, []);
  if (pullRequest === undefined) return null;
  const issueNames = (Object.keys(pullRequest.issues ?? {}) as IssueName[]).filter(issue => pullRequest.issues?.[issue] === true);
  const hasIssues = issueNames.length > 0;
  const label = `${statusLabel[pullRequest.status]} pull request #${pullRequest.number}: ${pullRequest.title}`;
  const queueFixup = async () => {
    if (onFixup === undefined || queueing) return;
    setQueueing(true);
    try {
      if (!await onFixup()) return;
      setQueued(true);
      if (queuedTimer.current !== undefined) window.clearTimeout(queuedTimer.current);
      queuedTimer.current = window.setTimeout(() => {
        queuedTimer.current = undefined;
        setQueued(false);
      }, 1_600);
    } finally {
      setQueueing(false);
    }
  };
  return <div className={`pull-request-card status-${pullRequest.status}`}><a className="pull-request-card-main" href={pullRequest.url} target="_blank" rel="noreferrer" aria-label={label} title={label}><PullRequestStatusIcon status={pullRequest.status} className="pull-request-card-icon" /><strong>#{pullRequest.number}</strong><span>{pullRequest.title}</span></a><PullRequestIndicators checks={pullRequest.checks} issues={pullRequest.issues} />{hasIssues && onFixup !== undefined && <button className={`pull-request-fixup${queued ? ' queued' : ''}`} type="button" disabled={queueing} aria-label="Queue $fixup" title="Queue $fixup" onClick={() => void queueFixup()}>{queueing ? <span className="spinner" /> : queued ? <><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg>Queued</> : '$fixup'}</button>}</div>;
}
