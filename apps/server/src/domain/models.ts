export type SocketRef = { fingerprint: string; path: string; device: number; inode: number };
export type Pane = { paneId: string; sessionId: string; pid: number; path: string; title: string; command: string; socket: SocketRef };
export type OmxQuestion = { id: string; text: string; choices: string[]; paneId: string };
export type Agent = { id: string; paneId: string; sessionId: string; socketFingerprint: string; workspace: string; branch?: string; title: string; worktreeId?: string; worktreeLabel?: string; worktreeOrder?: number; projectUrl?: string; pullRequestUrl?: string; question?: OmxQuestion };
export type Worktree = { id: string; label: string; path: string; identity: string; hostPath?: string; available: boolean; pinned: boolean; command?: string; launch?: LaunchTemplate; projectUrl?: string };
export type LaunchTemplate = { program: string; args: string[] };
export type Dashboard = { generation: number; agents: Agent[]; worktrees: Array<Pick<Worktree, 'id'|'label'|'path'|'available'|'pinned'|'projectUrl'> & { order: number; branch?: string; pullRequestUrl?: string }> };
