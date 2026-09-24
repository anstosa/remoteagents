import { expect, type Locator, type Page } from '@playwright/test';

// One of a panel header's actions. A panel narrower than the fold width keeps its secondary actions
// in the header's ⋮, so this opens the ⋮ first when the panel has one.
export const panelAction = async (panel: Locator, name: string | RegExp, exact = true): Promise<Locator> => {
  const options = { name, exact: typeof name === 'string' && exact };
  const more = panel.locator('.panel-header-more');
  if (await more.count() === 0) return panel.getByRole('button', options);
  if (await more.getAttribute('aria-expanded') !== 'true') await more.click();
  return panel.page().locator('.panel-header-menu').getByRole('button', options);
};

// Choose one of the Code panel's view options (diff mode or layout) from its fly-out.
export const codeViewOption = async (panel: Locator, name: string): Promise<Locator> => {
  await (await panelAction(panel, 'View options')).click();
  return panel.getByRole('dialog', { name: 'View options' }).getByRole('button', { name, exact: true });
};

// Close an open header ⋮, so the rest of the page is clickable again.
export const closePanelMenu = async (page: Page) => {
  const open = page.locator('.panel-header-more[aria-expanded="true"]');
  if (await open.count() > 0) await open.press('Escape');
};

// Check one (possibly folded) action, then close the ⋮ it was read from.
export const expectPanelAction = async (panel: Locator, name: string | RegExp, check: (button: Locator) => Promise<void>) => {
  await check(await panelAction(panel, name));
  await closePanelMenu(panel.page());
};

// Use one (possibly folded) action; choosing it closes the ⋮. A panel that just changed width may
// fold or unfold under the click, so it retries until one lands.
export const clickPanelAction = async (panel: Locator, name: string | RegExp) => {
  await expect(async () => { await (await panelAction(panel, name)).click({ timeout: 2_000 }); }).toPass({ timeout: 15_000 });
};
