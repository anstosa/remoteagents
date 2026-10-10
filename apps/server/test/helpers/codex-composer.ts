// reproduce a filled native composer rather than an empty placeholder frame
export const codexComposerWithFooter = (composer: string, warnings = true): string => [
  `› ${composer || 'Ask Codex to do anything'}`,
  '',
  '  \x1b[38;2;246;226;183mGPT-6.1-Sol xhigh fast\x1b[39m · \x1b[38;2;171;223;167m~/weather\x1b[39m · \x1b[38;2;143;179;239mfeat/adjustment-maintenance-final-export-boundary\x1b[39m · Main [default]',
  // filled composers hide shortcuts but retain right-aligned native warnings
  warnings
    ? `${composer ? '' : '  \x1b[1m?\x1b[0m for shortcuts'}${' '.repeat(composer ? 126 : 109)}⚠ \x1b[38;2;196;167;103m2 warnings\x1b[39m · \x1b[1mf2\x1b[0m to view`
    : composer ? '' : '  \x1b[1m?\x1b[0m for shortcuts',
  ''
].join('\n');
