/**
 * Program basenames the recognizers and the config self-checks agree on. A leaf
 * module (no imports) so both the Adapters' process recognizers and
 * `config/schema.ts` can name a kind's executable without depending on an Adapter.
 */

/** A Node runtime by basename: the launcher every npm/mise-installed CLI runs under. */
export const nodeProgramName = /^(?:node|nodejs)(?:\.exe)?$/iu;
/** The Codex executable or launcher script by basename. */
export const codexProgramName = /^codex(?:\.js)?$/iu;
/** The OMX executable or packaged CLI entry (`dist/cli/omx.js`) by basename. */
export const omxProgramName = /^omx(?:\.js)?$/iu;
