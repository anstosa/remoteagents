// Apply the stored colour flavour to the document before first paint, so a Latte
// user's reload never flashes the default Mocha theme. This runs as a
// render-blocking classic script in the <head> — earlier than the deferred app
// module and before the stylesheet paints — and mirrors the store's read logic
// (key `rac.color-theme`, value `'latte'`, Mocha = the key's absence) in
// apps/web/src/color-theme.ts. It is an external same-origin file rather than an
// inline <script> because the app's Content-Security-Policy (`default-src 'self'`,
// no `script-src`) forbids inline scripts. Keep this in sync with the store; the
// store re-applies the same flavour on mount, so a drift here only costs a flash.
try {
  if (localStorage.getItem('rac.color-theme') === 'latte') {
    document.documentElement.dataset.theme = 'latte';
    // Match the Latte `--base` so the mobile browser chrome doesn't flash the
    // Mocha default (the static `<meta name="theme-color">` in index.html) before
    // the store re-applies it on mount. The literal mirrors `--base` under
    // `[data-theme="latte"]` in styles.css — the meta colour is a browser-chrome
    // attribute that needs a concrete hex and cannot reference a CSS variable.
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', '#eff1f5');
  }
} catch {
  // Private-mode storage access can throw; falling back to Mocha is harmless.
}
