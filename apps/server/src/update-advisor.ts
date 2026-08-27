const currentUpdateAdvisorLabel = /^Update Advisor v4 [0-9a-f]{7}$/u;
const pendingUpdateAdvisorLabel = /^Update Advisor Starting v4 [0-9a-f]{7}$/u;
const previousUpdateAdvisorLabel = /^Update Advisor v3 [0-9a-f]{7}$/u;
const olderUpdateAdvisorLabel = /^Update Advisor v2 [0-9a-f]{7}$/u;
const legacyUpdateAdvisorLabel = /^Update Advisor [0-9a-f]{7}$/u;

// create one writable server-owned advisor identity
export const updateAdvisorLabel = (targetSha: string): string => `Update Advisor v4 ${targetSha.slice(0, 7)}`;

// identify one advisor until its initial prompt is scheduled
export const updateAdvisorPendingLabel = (targetSha: string): string => `Update Advisor Starting v4 ${targetSha.slice(0, 7)}`;

// recognize current and cleanup-only legacy advisor identities
export const isUpdateAdvisorLabel = (label: string | undefined): boolean => label !== undefined && (currentUpdateAdvisorLabel.test(label) || pendingUpdateAdvisorLabel.test(label) || previousUpdateAdvisorLabel.test(label) || olderUpdateAdvisorLabel.test(label) || legacyUpdateAdvisorLabel.test(label));

// match every advisor identity for one reviewed target
export const isUpdateAdvisorForTarget = (label: string | undefined, targetSha: string): boolean => label === updateAdvisorLabel(targetSha)
  || label === updateAdvisorPendingLabel(targetSha)
  || label === `Update Advisor v3 ${targetSha.slice(0, 7)}`
  || label === `Update Advisor v2 ${targetSha.slice(0, 7)}`
  || label === `Update Advisor ${targetSha.slice(0, 7)}`;
