import type { Pane } from '../domain/models.js';
import { paneLabel, type CleanupClassification, type PaneScan } from './types.js';

// The Codex Adapter's one runtime-cleanup rule (ADR 0002): a pane recognised as
// Codex that the dashboard does not represent as a live Agent is a stale agent —
// unless another Adapter hides the pane (an OMX team worker running plain Codex),
// which the OMX Adapter's orphan rule covers. Codex hides no panes of its own and
// runs no helper processes; the OMX worker and HUD rules live in `omx-panes.ts`
// (ADR 0005).
export function classifyCodexPane(pane: Pane, scan: PaneScan): CleanupClassification | undefined {
  if (scan.recognizedKind(pane) !== 'codex' || scan.excluded(pane) || scan.active(pane)) return undefined;
  return { kind: 'stale-agent', label: 'Stale Codex agent', detail: `${paneLabel(pane)} at ${pane.path}` };
}
