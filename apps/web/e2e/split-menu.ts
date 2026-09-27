import { type Page } from '@playwright/test';

// open the phone split chooser from its full-width trigger
export const openSplitMenu = async (page: Page) => {
  await page.getByRole('group', { name: 'Panels' }).getByRole('button', { name: 'Choose split' }).click();
  return page.getByRole('menu', { name: 'Splits' });
};

// choose a titled split from the phone flyout
export const chooseSplit = async (page: Page, title: string) => {
  const menu = await openSplitMenu(page);
  await menu.getByRole('menuitem', { name: title, exact: true }).click();
};

// exercise touch navigation through both flyout taps
export const tapSplit = async (page: Page, title: string) => {
  await page.getByRole('group', { name: 'Panels' }).getByRole('button', { name: 'Choose split' }).tap();
  await page.getByRole('menu', { name: 'Splits' }).getByRole('menuitem', { name: title, exact: true }).tap();
};
