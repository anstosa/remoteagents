import { expect, test, type Page } from '@playwright/test';
import { installPaneMock } from './pane-stream-mock.js';
import { installFilesFixture } from './files-panel-fixture.js';

type EvidenceWindow = Window & { consoleReconnectTransitions: boolean[] };
type FailureOptions = { healthStatus?: number; healthDelay?: number; favoritesDelay?: number; favoritesFail?: boolean; favoritesAbort?: boolean; holdRecovery?: boolean };

// observe even brief overlays rather than only their final visibility
async function watchReconnects(page: Page) {
  await page.addInitScript(() => {
    const evidence = window as EvidenceWindow;
    evidence.consoleReconnectTransitions = [];
    document.addEventListener('DOMContentLoaded', () => {
      let visible = false;
      // record transitions when React changes the blocking overlay
      const sample = () => {
        const next = document.querySelector('[aria-label="Reconnecting to console"]') !== null;
        // ignore unrelated DOM mutations
        if (next === visible) return;
        visible = next;
        evidence.consoleReconnectTransitions.push(next);
      };
      new MutationObserver(sample).observe(document.body, { childList: true, subtree: true });
      sample();
    });
  });
}

// isolate unavailable Files operations from otherwise healthy console traffic
async function openUnavailableFiles(page: Page, options: FailureOptions = {}) {
  await installPaneMock(page);
  await installFilesFixture(page);
  await watchReconnects(page);
  const counts = { list: 0, health: 0, updates: 0 };
  await page.route('**/healthz', async route => {
    counts.health += 1;
    // retain an actual newer outage while the older healthy probe finishes
    if (options.holdRecovery && counts.health > 1) {
      await new Promise(resolve => setTimeout(resolve, 4_500));
      return route.abort('failed').catch(() => undefined);
    }
    await new Promise(resolve => setTimeout(resolve, options.healthDelay ?? 120));
    await route.fulfill({ status: options.healthStatus ?? 200, json: { ok: options.healthStatus !== 503 } });
  });
  await page.route('**/api/server/update-available', async route => {
    counts.updates += 1;
    await route.fulfill({ json: { available: false, commitCount: 0 } });
  });
  await page.route('**/api/worktrees/cora/file-favorites', async route => {
    await new Promise(resolve => setTimeout(resolve, options.favoritesDelay ?? 1_500));
    // supply newer definitive network-failure evidence
    if (options.favoritesAbort) return route.abort('failed');
    await route.fulfill(options.favoritesFail
      ? { status: 503, json: { error: { code: 'bridge_unavailable', message: 'host broker unavailable' } } }
      : { json: { favorites: [] } });
  });
  await page.route('**/api/worktrees/cora/files/list', async route => {
    counts.list += 1;
    await route.fulfill({ status: 503, json: { error: { code: 'bridge_unavailable', message: 'host broker unavailable' } } });
  });
  await page.goto('/');
  await page.getByRole('region', { name: 'Workspace toolbar' }).getByRole('button', { name: 'Files', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Files' });
  await expect(panel.getByRole('alert')).toHaveText('host broker unavailable');
  return { panel, counts, overlay: page.getByRole('alert', { name: 'Reconnecting to console' }) };
}

// retain operation failures without losing deliberate retry controls
test('Files 503 stays inline without reconnect flapping or automatic retries', async ({ page }) => {
  const { panel, counts, overlay } = await openUnavailableFiles(page);
  // allow enough time for the old uncontrolled retry loop to repeat
  await page.waitForTimeout(2_000);
  expect(counts.list).toBe(1);
  expect(counts.health).toBe(1);
  expect(counts.updates).toBe(1);
  await expect(overlay).toHaveCount(0);
  expect(await page.evaluate(() => (window as EvidenceWindow).consoleReconnectTransitions)).toEqual([]);

  // manual refresh remains a single deliberate retry
  await panel.getByRole('button', { name: 'Refresh files' }).click();
  await expect(panel.getByRole('alert')).toHaveText('host broker unavailable');
  await page.waitForTimeout(600);
  expect(counts.list).toBe(2);
  expect(counts.health).toBe(2);
  expect(await page.evaluate(() => (window as EvidenceWindow).consoleReconnectTransitions)).toEqual([]);

  // closing does not retry and reopening permits one fresh attempt
  await panel.getByRole('button', { name: 'Close files' }).click();
  await expect(panel).toHaveCount(0);
  await page.waitForTimeout(600);
  expect(counts.list).toBe(2);
  await page.getByRole('region', { name: 'Workspace toolbar' }).getByRole('button', { name: 'Files', exact: true }).click();
  await expect(panel.getByRole('alert')).toHaveText('host broker unavailable');
  await page.waitForTimeout(600);
  expect(counts.list).toBe(3);
  expect(counts.health).toBe(3);
  expect(counts.updates).toBe(1);
  expect(await page.evaluate(() => (window as EvidenceWindow).consoleReconnectTransitions)).toEqual([]);
});

// coalesce concurrent unavailable operations into one connectivity check
test('concurrent Files 503 responses share one health confirmation', async ({ page }) => {
  const { counts, overlay } = await openUnavailableFiles(page, { healthDelay: 500, favoritesDelay: 0, favoritesFail: true });
  await page.waitForTimeout(1_000);
  expect(counts.list).toBe(1);
  expect(counts.health).toBe(1);
  await expect(overlay).toHaveCount(0);
  expect(await page.evaluate(() => (window as EvidenceWindow).consoleReconnectTransitions)).toEqual([]);
});

// keep newer successful connectivity evidence authoritative
test('late failed health confirmation cannot override a newer successful response', async ({ page }) => {
  const { counts, overlay } = await openUnavailableFiles(page, { healthStatus: 503, healthDelay: 1_500, favoritesDelay: 100 });
  await page.waitForTimeout(2_000);
  expect(counts.list).toBe(1);
  expect(counts.health).toBe(1);
  await expect(overlay).toHaveCount(0);
  expect(await page.evaluate(() => (window as EvidenceWindow).consoleReconnectTransitions)).toEqual([]);
});

// keep newer genuine network failures authoritative
test('late healthy confirmation cannot override a newer network failure', async ({ page }) => {
  const { counts, overlay } = await openUnavailableFiles(page, { healthDelay: 1_200, favoritesDelay: 200, favoritesAbort: true, holdRecovery: true });
  await expect(overlay).toBeVisible();
  // let the obsolete healthy probe return while the genuine outage stays active
  await page.waitForTimeout(1_500);
  expect(counts.list).toBe(1);
  expect(counts.health).toBe(2);
  await expect(overlay).toBeVisible();
  expect(await page.evaluate(() => (window as EvidenceWindow).consoleReconnectTransitions)).toEqual([true]);
});
