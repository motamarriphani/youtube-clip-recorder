const path = require('path');
const { test, expect, chromium } = require('@playwright/test');

const TEST_VIDEO_URL = 'https://www.youtube.com/watch?app=desktop&v=jNQXAC9IVRw';
const EXTENSION_PATH = path.resolve(__dirname, '..');

async function maybeAcceptConsent(page) {
  const candidates = [
    page.getByRole('button', { name: /accept all/i }),
    page.getByRole('button', { name: /i agree/i }),
    page.getByRole('button', { name: /accept/i }),
  ];

  for (const locator of candidates) {
    try {
      if (await locator.isVisible({ timeout: 1500 })) {
        await locator.click();
        return;
      }
    } catch (_) {
      // ignore and try next candidate
    }
  }
}

function getProfileDir(testInfo) {
  const safeName = testInfo.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  return path.resolve(__dirname, '..', '.playwright-profile', safeName);
}

async function launchExtensionContext(testInfo) {
  return chromium.launchPersistentContext(getProfileDir(testInfo), {
    headless: false,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
    ],
  });
}

async function getExtensionId(context) {
  let [worker] = context.serviceWorkers();
  if (!worker) {
    worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
  }
  return worker.url().split('/')[2];
}

test('injects recorder controls on YouTube watch page', async ({}, testInfo) => {
  const context = await launchExtensionContext(testInfo);

  const page = context.pages()[0] || await context.newPage();
  await page.goto(TEST_VIDEO_URL, { waitUntil: 'domcontentloaded' });
  await maybeAcceptConsent(page);

  await expect(page.locator('.ytp-right-controls')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#yt-clip-recorder-button')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#yt-clip-recorder-audio-toggle')).toBeVisible({ timeout: 20_000 });

  await context.close();
});

test('reinjects controls if YouTube re-renders and removes them', async ({}, testInfo) => {
  const context = await launchExtensionContext(testInfo);
  const page = context.pages()[0] || await context.newPage();

  await page.goto(TEST_VIDEO_URL, { waitUntil: 'domcontentloaded' });
  await maybeAcceptConsent(page);

  await expect(page.locator('#yt-clip-recorder-button')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#yt-clip-recorder-audio-toggle')).toBeVisible({ timeout: 20_000 });

  await page.evaluate(() => {
    document.getElementById('yt-clip-recorder-button')?.remove();
    document.getElementById('yt-clip-recorder-audio-toggle')?.remove();
  });

  await expect(page.locator('#yt-clip-recorder-button')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('#yt-clip-recorder-audio-toggle')).toBeVisible({ timeout: 10_000 });

  await context.close();
});

test('popup loads settings controls and saves duration', async ({}, testInfo) => {
  const context = await launchExtensionContext(testInfo);
  const extensionId = await getExtensionId(context);

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'domcontentloaded' });

  const durationSelect = popup.locator('#duration');
  await expect(durationSelect).toBeVisible();
  await expect(popup.locator('#save')).toBeVisible();

  await durationSelect.selectOption('45');
  await popup.locator('#save').click();
  await expect(popup.locator('#status')).toContainText('Saved.', { timeout: 5_000 });

  const storedValue = await popup.evaluate(async () => {
    const settings = await chrome.storage.sync.get('maxRecordDurationSeconds');
    return settings.maxRecordDurationSeconds;
  });
  expect(storedValue).toBe(45);

  await context.close();
});
