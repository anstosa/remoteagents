export type ReviewCategory = 'implementation' | 'test' | 'doc';

const documentationFile = /^(?:changelog|code_of_conduct|contributing|license|readme|security)(?:\.|$)/u;

// classify review paths consistently
export function classifyReviewPath(path: string): ReviewCategory {
  const lower = path.toLowerCase();
  const name = lower.slice(lower.lastIndexOf('/') + 1);
  // prefer documentation for overlapping paths
  if (/(^|\/)(?:docs?|documentation)(?:\/|$)/u.test(lower) || /\.(?:adoc|md|mdx|rst)$/u.test(name) || documentationFile.test(name)) return 'doc';
  // recognize test conventions
  if (/(^|\/)(?:__tests__|e2e|specs?|tests?)(?:\/|$)/u.test(lower) || /(?:^|[._-])(?:spec|test)(?:[._-]|$)/u.test(name)) return 'test';
  return 'implementation';
}
