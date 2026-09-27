import { expect, test } from '@playwright/test';

// align outlined tab-strip controls with the shared control height
test('keeps phone icon controls square and aligned with the workspace tab', async ({ page }) => {
  await page.goto('/');
  await page.setContent(`
    <link rel="stylesheet" href="/src/styles.css">
    <nav class="tabs workspace-dropdown-row" role="tablist">
      <div class="tab-row-lead">
        <button class="server-switcher-button server-selector" aria-label="Switch server"><img src="/instance-icons/terminal.svg" alt=""><span class="server-selector-name">Server</span><svg class="server-selector-chevron" viewBox="0 0 24 24"></svg><i class="server-switcher-attention working"></i></button>
        <button class="server-switcher-button server-switcher-voice" aria-label="Call"><svg viewBox="0 0 24 24"></svg><span>Call</span></button>
        <span class="server-switcher-settings-wrap"><button class="server-switcher-button server-switcher-settings" aria-label="Settings"><svg viewBox="0 0 24 24"></svg><span class="server-switcher-settings-update-dot"></span></button></span>
      </div>
      <button class="workspace-dropdown active" role="tab" aria-selected="true"><span class="tab-kind-stack"><span class="tab-place-mark">◈</span></span><span class="workspace-dropdown-label">Workspace</span><svg class="workspace-dropdown-chevron" viewBox="0 0 24 24"></svg></button>
      <span class="launcher"><button class="new-agent-tab" aria-label="Launch agent">+</button></span>
    </nav>
  `);
  await page.setViewportSize({ width: 390, height: 844 });
  const controls = [page.getByRole('button', { name: 'Switch server' }), page.getByRole('button', { name: 'Call' }), page.getByRole('button', { name: 'Settings' }), page.getByRole('button', { name: 'Launch agent' })];
  const tab = page.getByRole('tab', { name: /Workspace/u });
  const tabBox = await tab.boundingBox();
  expect(tabBox).not.toBeNull();
  // compare the visible buttons rather than their layout wrappers
  for (const control of controls) {
    const box = await control.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeCloseTo(41.6, 1);
    expect(box!.height).toBeCloseTo(41.6, 1);
    expect(box!.y).toBeCloseTo(tabBox!.y, 1);
    // the server icon alone is edge-to-edge, unlike the outlined peer controls
    await expect(control).toHaveCSS('border-top-width', control === controls[0] ? '0px' : '1px');
    await expect(control).not.toHaveCSS('border-radius', '0px');
  }
  expect(tabBox!.height).toBeCloseTo(41.6, 1);
  await expect(tab).toHaveCSS('border-top-width', '1px');
  // align both corner dots to the same outer button inset despite different borders
  const [serverBox, serverDotBox, mobileSettingsBox, settingsDotBox] = await Promise.all([controls[0].boundingBox(), controls[0].locator('.server-switcher-attention').boundingBox(), controls[2].boundingBox(), controls[2].locator('.server-switcher-settings-update-dot').boundingBox()]);
  expect(serverDotBox!.y - serverBox!.y).toBeCloseTo(4, 1);
  expect(settingsDotBox!.y - mobileSettingsBox!.y).toBeCloseTo(4, 1);
  expect(serverBox!.x + serverBox!.width - serverDotBox!.x - serverDotBox!.width).toBeCloseTo(4, 1);
  expect(mobileSettingsBox!.x + mobileSettingsBox!.width - settingsDotBox!.x - settingsDotBox!.width).toBeCloseTo(4, 1);
  // keep the outlined row inside a narrow viewport
  expect(await page.locator('.tabs').evaluate(nav => nav.scrollWidth <= nav.clientWidth)).toBe(true);

  await page.setViewportSize({ width: 1280, height: 800 });
  const desktopTab = await tab.boundingBox();
  const [settingsBox, plusBox] = await Promise.all([controls[2].boundingBox(), controls[3].boundingBox()]);
  expect(desktopTab).not.toBeNull();
  expect(settingsBox).not.toBeNull();
  expect(plusBox).not.toBeNull();
  expect(settingsBox!.height).toBeCloseTo(desktopTab!.height, 1);
  expect(plusBox!.height).toBeCloseTo(desktopTab!.height, 1);
  expect(settingsBox!.width).toBeCloseTo(settingsBox!.height, 1);
  expect(plusBox!.width).toBeCloseTo(plusBox!.height, 1);
});
