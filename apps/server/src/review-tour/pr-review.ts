import { createHash } from 'node:crypto';
import { z } from 'zod';
import { gitStatusSummary } from '../git/comparison.js';
import { at, GithubClient, GithubRequestError, githubErrorMessage, githubRepository, githubToken, graphqlError, type Command, type GithubRepository, type GraphqlPayload, type Request, type Token } from '../pull-requests/github.js';
import { run } from '../tmux/command.js';
import { ReviewTourError, type ReviewComparison, type ReviewTourInput } from './contracts.js';

// Posts a Review tour's feedback to the branch's GitHub pull request as the operator's pending
// (draft) review, which they finish on GitHub. Inline comments land as line threads where
// GitHub's own diff carries the same rows at the same line numbers, and as file-level threads
// quoting the commented rows where it does not. Line numbers must name committed, pushed
// content: a commented file must be clean, local HEAD must be the PR's head, and an existing
// pending review must sit on that same commit. Every thread and the summary carry a hidden
// marker, so a retry, a double submit, or a lost response never posts anything twice.

type Capture = (agentId: string, input: ReviewTourInput) => Promise<ReviewComparison>;

// 200 comments of 4,000 characters and a 20,000-character body, at up to three UTF-8 bytes a
// character; the web caps a tour's total feedback at 20,000 characters, far below this
export const PR_REVIEW_REQUEST_BODY_BYTES = 3_145_728;
const maxBody = 20_000;
const maxComments = 200;
const maxComment = 4_000;
// GitHub lists at most 3000 files of a pull request
const maxFilePages = 30;
const maxCommentPages = 50;
// threads added per GraphQL request; each is a separate mutation run in order
const threadBatch = 10;
const maxQuotedRows = 8;
const markerPattern = /<!-- rac:([A-Za-z0-9_-]+) -->/gu;

export type ReviewDiffSide = 'deletions' | 'additions';
export type PullRequestReviewComment = { id: string; changeId: string; startSide: ReviewDiffSide; startLine: number; endSide: ReviewDiffSide; endLine: number; body: string };
type CommentRange = Pick<PullRequestReviewComment, 'startSide' | 'startLine' | 'endSide' | 'endLine'>;
// `body` is the review summary; empty leaves the review's body as it is (a retry sends it empty)
export type PullRequestReviewInput = { scope: 'pr'; includeTests: boolean; includeDocs: boolean; fingerprint: string; body: string; comments: PullRequestReviewComment[] };
// `file` is a comment posted as a file-level thread, `reason` saying why it could not sit on its lines
export type PullRequestReviewCommentResult = { id: string; result: 'line' | 'file' | 'failed'; reason?: string };
export type PullRequestReviewResult = { status: 'ok'; review: { url: string; pullRequest: { number: number; url: string } }; bodyPosted: boolean; comments: PullRequestReviewCommentResult[] };
export type PullRequestReviewErrorCode = 'stale' | 'uncommitted' | 'no_pull_request' | 'no_github_token' | 'head_mismatch' | 'pending_review_outdated' | 'github_forbidden' | 'github_failed';

export class PullRequestReviewError extends Error {
  // carry an operator-facing message and the details the client shows with it
  constructor(readonly code: PullRequestReviewErrorCode, readonly retryable: boolean, message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'PullRequestReviewError';
  }

  get httpStatus(): number { return this.code === 'github_failed' || this.code === 'github_forbidden' ? 502 : 409; }
}

// a GitHub failure as the post's error: refused credentials or permission, else a retryable-or-not failure
function reviewError(error: unknown): unknown {
  if (!(error instanceof GithubRequestError)) return error;
  const details = error.githubStatus === undefined ? {} : { githubStatus: error.githubStatus };
  return error.kind === 'forbidden' ? new PullRequestReviewError('github_forbidden', false, error.message, details) : new PullRequestReviewError('github_failed', error.kind === 'transient', error.message, details);
}

const sideSchema = z.enum(['deletions', 'additions']);
// an id travels inside an HTML comment marker, so it is held to a charset that cannot close one
const commentSchema = z.object({ id: z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/u), changeId: z.string().min(8).max(100), startSide: sideSchema, startLine: z.number().int().positive(), endSide: sideSchema, endLine: z.number().int().positive(), body: z.string().max(maxComment).refine(body => body.trim() !== '') }).strict();
const inputSchema = z.object({ scope: z.literal('pr'), includeTests: z.boolean(), includeDocs: z.boolean(), fingerprint: z.string().min(16).max(128), body: z.string().max(maxBody), comments: z.array(commentSchema).max(maxComments) }).strict()
  // require something to post, and ids the results can be keyed by
  .refine(input => input.body.trim() !== '' || input.comments.length > 0)
  .refine(input => new Set(input.comments.map(comment => comment.id)).size === input.comments.length);

// parse the exact post request
export function parsePullRequestReviewInput(value: unknown): PullRequestReviewInput | undefined {
  const parsed = inputSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

// ---- Pure diff helpers ----------------------------------------------------------------------

// one row of a unified diff: its hunk, its old and/or new line number, and its text without the prefix
export type DiffRow = { hunk: number; old?: number; new?: number; text: string };

// number a unified patch's rows; anything before the first hunk header (a file header) is skipped,
// so this reads both a tour Change's patch and GitHub's header-less `patch`
export function diffRows(patch: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let hunk = -1;
  let oldLine = 0;
  let newLine = 0;
  for (const line of patch.split('\n')) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(line);
    if (header !== null) { hunk += 1; oldLine = Number(header[1]); newLine = Number(header[2]); continue; }
    if (hunk < 0) continue;
    const text = line.slice(1);
    if (line.startsWith('-')) rows.push({ hunk, old: oldLine++, text });
    else if (line.startsWith('+')) rows.push({ hunk, new: newLine++, text });
    else if (line.startsWith(' ')) rows.push({ hunk, old: oldLine++, new: newLine++, text });
  }
  return rows;
}

const lineOn = (side: ReviewDiffSide, row: DiffRow) => side === 'deletions' ? row.old : row.new;
const rowIndexes = (rows: DiffRow[], comment: CommentRange) => [rows.findIndex(row => lineOn(comment.startSide, row) === comment.startLine), rows.findIndex(row => lineOn(comment.endSide, row) === comment.endLine)] as const;

// the rows a comment's range covers, inclusive and in row order whichever end was named first;
// undefined when an end is missing
export function coveredRows(rows: DiffRow[], comment: CommentRange): DiffRow[] | undefined {
  const [start, end] = rowIndexes(rows, comment);
  return start < 0 || end < 0 ? undefined : rows.slice(Math.min(start, end), Math.max(start, end) + 1);
}

// the comment with its ends swapped when they run backwards through the tour patch (an added block
// above a removed one can yield a removed start below an added end), so GitHub gets start before end
export function orderedComment<T extends CommentRange>(tourPatch: string, comment: T): T {
  const [start, end] = rowIndexes(diffRows(tourPatch), comment);
  return start >= 0 && end >= 0 && end < start ? { ...comment, startSide: comment.endSide, startLine: comment.endLine, endSide: comment.startSide, endLine: comment.startLine } : comment;
}

// a GitHub row stands for a tour row when its text matches at the same new line, or for a removed
// row, at the same old line
const sameRow = (remote: DiffRow, local: DiffRow) => remote.text === local.text && (local.new === undefined ? remote.new === undefined && remote.old === local.old : remote.new === local.new);

// why a comment cannot sit on its lines in GitHub's diff of the file; undefined when it can
export function placementProblem(tourPatch: string, githubPatch: string | undefined, comment: CommentRange): string | undefined {
  const local = coveredRows(diffRows(tourPatch), comment);
  if (local === undefined) return 'The commented lines are not in the tour\'s diff.';
  // GitHub omits the patch of a binary or very large file
  if (githubPatch === undefined) return 'GitHub shows no line diff for this file.';
  const remote = coveredRows(diffRows(githubPatch), comment);
  if (remote === undefined) return 'The commented lines are outside the pull request\'s diff on GitHub.';
  if (remote.some(row => row.hunk !== remote[0]!.hunk)) return 'The commented lines span more than one hunk on GitHub.';
  if (remote.length !== local.length || remote.some((row, index) => !sameRow(row, local[index]!))) return 'The pull request\'s diff on GitHub differs from the tour at these lines.';
  return undefined;
}

// a GitHub diff side for a tour side
export function githubSide(side: ReviewDiffSide): 'LEFT' | 'RIGHT' { return side === 'deletions' ? 'LEFT' : 'RIGHT'; }

// a comment's lines in words, e.g. "Lines 12–14 (new)"
export function commentLocation(comment: CommentRange): string {
  const side = (value: ReviewDiffSide) => value === 'deletions' ? 'old' : 'new';
  if (comment.startSide !== comment.endSide) return `Lines ${comment.startLine} (${side(comment.startSide)}) – ${comment.endLine} (${side(comment.endSide)})`;
  return comment.startLine === comment.endLine ? `Line ${comment.endLine} (${side(comment.endSide)})` : `Lines ${comment.startLine}–${comment.endLine} (${side(comment.endSide)})`;
}

// the tour patch rows a comment covers with their +/-/space prefixes, capped to the last few
export function quotedRows(tourPatch: string, comment: PullRequestReviewComment): string[] {
  const covered = (coveredRows(diffRows(tourPatch), comment) ?? []).map(row => `${row.old !== undefined && row.new !== undefined ? ' ' : row.new === undefined ? '-' : '+'}${row.text}`);
  return covered.length > maxQuotedRows ? ['…', ...covered.slice(-maxQuotedRows)] : covered;
}

// a file-level thread's text: the location, the quoted rows, then the comment
export function fileThreadBody(tourPatch: string, comment: PullRequestReviewComment): string {
  const quoted = quotedRows(tourPatch, comment);
  // outrun any backtick run in the quoted code
  const fence = '`'.repeat(Math.max(3, ...quoted.map(line => (line.match(/`+/gu) ?? []).reduce((longest, ticks) => Math.max(longest, ticks.length + 1), 0))));
  return [`**${commentLocation(comment)}**`, ...(quoted.length === 0 ? [] : [`${fence}diff\n${quoted.join('\n')}\n${fence}`]), comment.body.trim()].join('\n\n');
}

// the hidden marker a thread carries, naming the tour comment it posts
export function commentMarker(id: string): string { return `<!-- rac:${id} -->`; }

// the hidden marker a summary carries, naming its text
export function summaryMarker(body: string): string { return `<!-- rac-summary:${createHash('sha256').update(body).digest('hex').slice(0, 16)} -->`; }

// the tour comments a review already holds, by the markers in its comments' bodies
export function placedComments(comments: Array<{ body: string; subjectType?: string }>): Map<string, 'line' | 'file'> {
  const placed = new Map<string, 'line' | 'file'>();
  for (const comment of comments) for (const match of comment.body.matchAll(markerPattern)) placed.set(match[1]!, comment.subjectType === 'FILE' ? 'file' : 'line');
  return placed;
}

// one AddPullRequestReviewThreadInput; a line thread names its last line, and its first only when it spans several
export function threadInput(reviewId: string, path: string, comment: PullRequestReviewComment, placement: 'line' | 'file', body: string): Record<string, unknown> {
  if (placement === 'file') return { pullRequestReviewId: reviewId, path, body, subjectType: 'FILE' };
  const multiLine = comment.startSide !== comment.endSide || comment.startLine !== comment.endLine;
  return { pullRequestReviewId: reviewId, path, body, line: comment.endLine, side: githubSide(comment.endSide), ...(multiLine ? { startLine: comment.startLine, startSide: githubSide(comment.startSide) } : {}), subjectType: 'LINE' };
}

// one GraphQL request adding every thread, aliased t0, t1, … with one input variable each
export function threadMutation(inputs: Array<Record<string, unknown>>): { query: string; variables: Record<string, unknown> } {
  const declarations = inputs.map((_, index) => `$i${index}:AddPullRequestReviewThreadInput!`).join(',');
  const fields = inputs.map((_, index) => `t${index}:addPullRequestReviewThread(input:$i${index}){thread{id}}`).join(' ');
  return { query: `mutation(${declarations}){${fields}}`, variables: Object.fromEntries(inputs.map((input, index) => [`i${index}`, input])) };
}

// a batch whose outcome is unknown: no data and an error naming no alias
export function ambiguousBatch(payload: GraphqlPayload): boolean {
  const errors = Array.isArray(payload.errors) ? payload.errors as unknown[] : [];
  return (payload.data === null || payload.data === undefined) && errors.length > 0 && errors.every(error => !Array.isArray(at(error, 'path')));
}

// each aliased thread's failure reason, undefined where GitHub created it; GraphQL succeeds partially,
// naming a failed alias in an error's `path`
export function threadFailures(count: number, payload: unknown): Array<string | undefined> {
  const value = payload !== null && typeof payload === 'object' ? payload as GraphqlPayload : {};
  const byAlias = new Map<string, string>();
  let general: string | undefined;
  for (const error of Array.isArray(value.errors) ? value.errors as unknown[] : []) {
    const message = githubErrorMessage(error) ?? 'GitHub rejected the comment.';
    const path = at(error, 'path');
    const alias = Array.isArray(path) && typeof path[0] === 'string' ? path[0] : undefined;
    // an error without a path failed the whole request
    if (alias === undefined) general ??= message;
    else if (!byAlias.has(alias)) byAlias.set(alias, message);
  }
  const data = value.data !== null && typeof value.data === 'object' ? value.data : {};
  return Array.from({ length: count }, (_, index) => {
    const result = data[`t${index}`] as { thread?: { id?: unknown } | null } | null | undefined;
    return typeof result?.thread?.id === 'string' ? undefined : byAlias.get(`t${index}`) ?? general ?? 'GitHub did not create the comment thread.';
  });
}

// ---- Service ------------------------------------------------------------------------------------

type PendingReview = { id: string; body: string; commit?: string };
type PullRequestState = { id: string; number: number; url: string; headRefOid: string; pending?: PendingReview };
// a pending review as it stands: its body and the tour comments its threads already post
type ReviewState = { id: string; body: string; placed: Map<string, 'line' | 'file'> };
type PlannedThread = { comment: PullRequestReviewComment; path: string; placement: 'line' | 'file'; reason?: string; body: string };
// a batch either reports each thread, or failed in a way that may have applied some of it
type BatchOutcome = { ambiguous: false; failures: Array<string | undefined> } | { ambiguous: true; reason: string };

const git = '/usr/bin/git';
const pullRequestQuery = 'query($owner:String!,$name:String!,$branch:String!){repository(owner:$owner,name:$name){pullRequests(headRefName:$branch,states:[OPEN],first:20){nodes{id number url headRefOid headRepositoryOwner{login} reviews(states:[PENDING],first:1){nodes{id body commit{oid}}}}}}}';
const reviewQuery = 'query($id:ID!,$after:String){node(id:$id){...on PullRequestReview{id body comments(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{body subjectType}}}}}';

// a comment's result from where a thread already posts it
function placedResult(thread: PlannedThread, placement: 'line' | 'file'): PullRequestReviewCommentResult {
  return { id: thread.comment.id, result: placement, ...(placement === 'file' && thread.reason !== undefined ? { reason: thread.reason } : {}) };
}

export class PullRequestReviewService {
  // one post per checkout at a time: a second post waits, then finds the first one's markers and posts nothing again
  private readonly posting = new Map<string, Promise<unknown>>();
  private readonly github: GithubClient;

  constructor(private readonly capture: Capture, private readonly command: Command = run, request: Request = fetch, private readonly getToken: Token = githubToken) { this.github = new GithubClient(request, 15_000); }

  // post a tour's feedback as the operator's pending review on the branch's pull request
  async post(agentId: string, input: PullRequestReviewInput): Promise<PullRequestReviewResult> {
    const comparison = await this.capture(agentId, { scope: input.scope, includeTests: input.includeTests, includeDocs: input.includeDocs });
    // the comments' change ids and line numbers belong to the tour's Comparison
    if (comparison.fingerprint !== input.fingerprint) throw new PullRequestReviewError('stale', false, 'The worktree has changed since this tour was built. Rebuild the tour, then post again.');
    const previous = this.posting.get(comparison.workspace) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => await this.postTo(comparison, input));
    this.posting.set(comparison.workspace, current);
    try { return await current; } catch (error) { throw reviewError(error); } finally {
      // forget a settled post unless another queued behind it
      if (this.posting.get(comparison.workspace) === current) this.posting.delete(comparison.workspace);
    }
  }

  private async postTo(comparison: ReviewComparison, input: PullRequestReviewInput): Promise<PullRequestReviewResult> {
    const changes = new Map(comparison.changes.map(change => [change.id, change]));
    const results = new Map<string, PullRequestReviewCommentResult>();
    const known = input.comments.filter(comment => {
      // fail a comment on a Change the Comparison no longer has
      if (changes.has(comment.changeId)) return true;
      results.set(comment.id, { id: comment.id, result: 'failed', reason: 'The comment\'s change is not in the tour.' });
      return false;
    });
    const files = [...new Set(known.map(comment => changes.get(comment.changeId)!.file))];
    await this.requireCommitted(comparison.workspace, files);
    const repository = await this.repository(comparison.workspace);
    // require a GitHub origin and a branch to find the pull request by
    if (repository === undefined) throw new PullRequestReviewError('no_pull_request', false, 'The worktree\'s origin is not a GitHub repository.');
    const branch = comparison.branch;
    if (branch === undefined) throw new PullRequestReviewError('no_pull_request', false, 'The worktree is not on a branch, so it has no pull request.');
    const token = await this.getToken();
    if (token === undefined) throw new PullRequestReviewError('no_github_token', false, 'GitHub authentication is not configured. Set RAC_GITHUB_TOKEN or sign in with the gh CLI.');
    const [head, pullRequest] = await Promise.all([this.head(comparison.workspace), this.pullRequest(token, repository, branch)]);
    // the comments' lines are local commits' lines, so they must be the PR's head
    if (head !== pullRequest.headRefOid) throw new PullRequestReviewError('head_mismatch', true, 'Your local commit does not match the pull request\'s head on GitHub. Push your commits (or pull), then post again.', { localHead: head, pullRequestHead: pullRequest.headRefOid });
    // threads attach to the draft's commit, so an older draft would misplace them
    this.requireCurrentDraft(pullRequest.pending, head);
    const remoteFiles = files.length === 0 ? new Map<string, { patch?: string }>() : await this.files(token, repository, pullRequest.number, new Set(files));
    const planned: PlannedThread[] = [];
    // place each comment on its lines, else on its file
    for (const requested of known) {
      const change = changes.get(requested.changeId)!;
      const comment = orderedComment(change.patch, requested);
      const remote = remoteFiles.get(change.file);
      if (remote === undefined) { results.set(comment.id, { id: comment.id, result: 'failed', reason: 'The file is not part of the pull request on GitHub.' }); continue; }
      const reason = placementProblem(change.patch, remote.patch, comment);
      const text = reason === undefined ? comment.body.trim() : fileThreadBody(change.patch, comment);
      planned.push({ comment, path: change.file, placement: reason === undefined ? 'line' : 'file', ...(reason === undefined ? {} : { reason }), body: `${text}\n\n${commentMarker(comment.id)}` });
    }
    const body = input.body.trim();
    const summary = body === '' ? '' : `${body}\n\n${summaryMarker(body)}`;
    let review = pullRequest.pending === undefined ? undefined : await this.reviewState(token, pullRequest.pending.id);
    // open a draft only when there is something to put in it
    if (review === undefined && (planned.length > 0 || summary !== '')) review = await this.openReview(token, repository, branch, pullRequest.id, head, summary);
    let bodyPosted = false;
    // add the summary unless the review already carries it
    if (review !== undefined && summary !== '') {
      if (!review.body.includes(summaryMarker(body))) await this.updateReviewBody(token, review.id, review.body.trim() === '' ? summary : `${review.body}\n\n${summary}`);
      bodyPosted = true;
    }
    // a comment some earlier post already placed keeps that placement
    const fresh = planned.filter(thread => {
      const placed = review?.placed.get(thread.comment.id);
      if (placed !== undefined) results.set(thread.comment.id, placedResult(thread, placed));
      return placed === undefined;
    });
    // add the rest in batches; a failure is reported for the client to retry, never retried here
    for (let start = 0; start < fresh.length; start += threadBatch) {
      const batch = fresh.slice(start, start + threadBatch);
      const outcome = await this.addThreads(token, batch.map(thread => threadInput(review!.id, thread.path, thread.comment, thread.placement, thread.body)));
      if (!outcome.ambiguous) {
        batch.forEach((thread, index) => results.set(thread.comment.id, outcome.failures[index] === undefined ? placedResult(thread, thread.placement) : { id: thread.comment.id, result: 'failed', reason: outcome.failures[index] }));
        continue;
      }
      // read back what the batch did; without that, all of it counts as failed and a retry dedupes
      const reread = await this.reviewState(token, review!.id).catch(() => undefined);
      batch.forEach(thread => {
        const placed = reread?.placed.get(thread.comment.id);
        results.set(thread.comment.id, placed === undefined ? { id: thread.comment.id, result: 'failed', reason: outcome.reason } : placedResult(thread, placed));
      });
    }
    return { status: 'ok', review: { url: `${pullRequest.url}/files`, pullRequest: { number: pullRequest.number, url: pullRequest.url } }, bodyPosted, comments: input.comments.map(comment => results.get(comment.id)!) };
  }

  // refuse a pending review on another commit
  private requireCurrentDraft(pending: PendingReview | undefined, head: string): void {
    if (pending !== undefined && pending.commit !== head) throw new PullRequestReviewError('pending_review_outdated', true, 'You have a pending review on an older commit of this pull request. Submit or discard it on GitHub first.', { pendingReviewCommit: pending.commit ?? null, head });
  }

  // refuse commented files whose working tree differs from HEAD, staged, unstaged or untracked
  private async requireCommitted(workspace: string, files: string[]): Promise<void> {
    if (files.length === 0) return;
    const status = await this.command(git, ['--no-optional-locks', '--literal-pathspecs', '-C', workspace, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...files]);
    if (status.code !== 0) throw new ReviewTourError('scope_unavailable', true);
    const dirty = [...new Set((gitStatusSummary(status.stdout).changes ?? []).map(change => change.path))];
    if (dirty.length > 0) throw new PullRequestReviewError('uncommitted', true, `Commit and push ${dirty.length === 1 ? 'this file' : 'these files'} first; the comments' line numbers must match the pull request: ${dirty.join(', ')}`, { files: dirty });
  }

  private async repository(workspace: string): Promise<GithubRepository | undefined> {
    const remote = await this.command(git, ['-C', workspace, 'remote', 'get-url', 'origin']);
    return remote.code === 0 ? githubRepository(remote.stdout) : undefined;
  }

  private async head(workspace: string): Promise<string> {
    const head = await this.command(git, ['-C', workspace, 'rev-parse', '--verify', 'HEAD']);
    if (head.code !== 0) throw new ReviewTourError('scope_unavailable', true);
    return head.stdout.trim().toLowerCase();
  }

  // the branch's open pull request from origin's own owner, with the viewer's pending review
  private async pullRequest(token: string, repository: GithubRepository, branch: string): Promise<PullRequestState> {
    const action = 'GitHub could not load the pull request';
    const payload = await this.github.query(token, pullRequestQuery, { owner: repository.owner, name: repository.name, branch }, action);
    const nodes = at(payload.data, 'repository', 'pullRequests', 'nodes');
    if (!Array.isArray(nodes)) throw graphqlError(payload, action);
    const node = nodes.find(candidate => String(at(candidate, 'headRepositoryOwner', 'login')).toLowerCase() === repository.owner.toLowerCase());
    if (node === undefined) throw new PullRequestReviewError('no_pull_request', true, `No open pull request was found for ${branch} on GitHub.`);
    const [id, number, url, headRefOid] = [at(node, 'id'), at(node, 'number'), at(node, 'url'), at(node, 'headRefOid')];
    if (typeof id !== 'string' || !Number.isInteger(number) || typeof url !== 'string' || typeof headRefOid !== 'string') throw new GithubRequestError('GitHub returned invalid pull request data.');
    const review = (at(node, 'reviews', 'nodes') as unknown[] | undefined)?.[0];
    const [reviewId, reviewBody, commit] = [at(review, 'id'), at(review, 'body'), at(review, 'commit', 'oid')];
    return { id, number: number as number, url, headRefOid: headRefOid.toLowerCase(), ...(typeof reviewId === 'string' ? { pending: { id: reviewId, body: typeof reviewBody === 'string' ? reviewBody : '', ...(typeof commit === 'string' ? { commit: commit.toLowerCase() } : {}) } } : {}) };
  }

  // a pending review's body and every comment it holds, page by page
  private async reviewState(token: string, id: string): Promise<ReviewState> {
    const action = 'GitHub could not read the pending review';
    const comments: Array<{ body: string; subjectType?: string }> = [];
    let body = '';
    let after: string | undefined;
    for (let page = 0; page < maxCommentPages; page += 1) {
      const payload = await this.github.query(token, reviewQuery, { id, ...(after === undefined ? {} : { after }) }, action);
      const node = at(payload.data, 'node');
      const nodes = at(node, 'comments', 'nodes');
      if (!Array.isArray(nodes)) throw graphqlError(payload, action);
      body = typeof at(node, 'body') === 'string' ? at(node, 'body') as string : '';
      for (const comment of nodes) {
        const [text, subjectType] = [at(comment, 'body'), at(comment, 'subjectType')];
        if (typeof text === 'string') comments.push({ body: text, ...(typeof subjectType === 'string' ? { subjectType } : {}) });
      }
      const cursor = at(node, 'comments', 'pageInfo', 'endCursor');
      if (at(node, 'comments', 'pageInfo', 'hasNextPage') !== true || typeof cursor !== 'string') break;
      after = cursor;
    }
    return { id, body, placed: placedComments(comments) };
  }

  // the PR's files that carry comments, each with GitHub's patch when it shows one
  private async files(token: string, repository: GithubRepository, number: number, wanted: Set<string>): Promise<Map<string, { patch?: string }>> {
    const found = new Map<string, { patch?: string }>();
    for (let page = 1; page <= maxFilePages && found.size < wanted.size; page += 1) {
      const response = await this.github.get(`https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/pulls/${number}/files?per_page=100&page=${page}`, token, 'GitHub could not list the pull request\'s files');
      const listed = await response.json().catch(() => undefined);
      if (!Array.isArray(listed)) throw new GithubRequestError('GitHub returned invalid pull request files.', 502, undefined, 'transient');
      for (const file of listed) {
        const [filename, patch] = [at(file, 'filename'), at(file, 'patch')];
        if (typeof filename === 'string' && wanted.has(filename)) found.set(filename, typeof patch === 'string' ? { patch } : {});
      }
      // a short page is the last one
      if (listed.length < 100) break;
    }
    return found;
  }

  // open a pending review on the head commit (no `event` keeps it a draft); when the outcome is
  // unknown, a draft that now exists on the head is the one this opened
  private async openReview(token: string, repository: GithubRepository, branch: string, pullRequestId: string, head: string, summary: string): Promise<ReviewState> {
    const action = 'GitHub could not start a pending review';
    try {
      const payload = await this.github.mutate(token, 'mutation($input:AddPullRequestReviewInput!){addPullRequestReview(input:$input){pullRequestReview{id}}}', { input: { pullRequestId, commitOID: head, ...(summary === '' ? {} : { body: summary }) } }, action);
      const id = at(payload.data, 'addPullRequestReview', 'pullRequestReview', 'id');
      if (typeof id !== 'string') throw graphqlError(payload, action);
      return { id, body: summary, placed: new Map() };
    } catch (error) {
      if (!(error instanceof GithubRequestError) || error.kind !== 'transient') throw error;
      const pending = (await this.pullRequest(token, repository, branch)).pending;
      if (pending === undefined) throw error;
      this.requireCurrentDraft(pending, head);
      return await this.reviewState(token, pending.id);
    }
  }

  private async updateReviewBody(token: string, pullRequestReviewId: string, body: string): Promise<void> {
    const action = 'GitHub could not update the pending review';
    const payload = await this.github.mutate(token, 'mutation($input:UpdatePullRequestReviewInput!){updatePullRequestReview(input:$input){pullRequestReview{id}}}', { input: { pullRequestReviewId, body } }, action);
    if (typeof at(payload.data, 'updatePullRequestReview', 'pullRequestReview', 'id') !== 'string') throw graphqlError(payload, action);
  }

  // add one batch of threads; a refused request fails each thread, a lost or broken one is ambiguous
  private async addThreads(token: string, inputs: Array<Record<string, unknown>>): Promise<BatchOutcome> {
    const action = 'GitHub could not add the comments';
    const mutation = threadMutation(inputs);
    let payload: GraphqlPayload;
    try {
      payload = await this.github.mutate(token, mutation.query, mutation.variables, action, 30_000);
    } catch (error) {
      const reason = error instanceof Error ? error.message : `${action}.`;
      return error instanceof GithubRequestError && error.kind !== 'transient' ? { ambiguous: false, failures: inputs.map(() => reason) } : { ambiguous: true, reason };
    }
    return ambiguousBatch(payload) ? { ambiguous: true, reason: graphqlError(payload, action).message } : { ambiguous: false, failures: threadFailures(inputs.length, payload) };
  }
}
