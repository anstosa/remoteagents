import { expect, test } from '@playwright/test';
test('renders the protected console login screen', async ({ page }) => { await page.goto('/'); await expect(page).toHaveTitle('Remote Agent Console'); await expect(page.getByRole('heading', { name: 'Remote Agent Console' })).toBeVisible(); await expect(page.getByLabel('Password')).toBeVisible(); });
