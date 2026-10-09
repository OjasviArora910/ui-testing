import { chromium } from 'playwright';

const baseUrl = process.env.WIZARD_TEST_URL ?? 'http://127.0.0.1:5173/';
const createRun = process.env.WIZARD_TEST_CREATE_RUN === '1';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1590, height: 1049 } });
page.setDefaultTimeout(8000);

const requests = [];
page.on('request', (request) => {
  if (request.url().includes('/api/runs')) {
    requests.push({ method: request.method(), url: request.url(), body: request.postData() });
  }
});

try {
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /New Test/ }).click().catch(() => undefined);

  await page.getByLabel('Target Web Application URL').fill('http://127.0.0.1:3000');
  await page.getByRole('button', { name: /Next/ }).click();
  await expectHeading('Authentication');

  await page.getByRole('button', { name: /Next/ }).click();
  await expectHeading('Testing Intelligence Mode');

  requests.length = 0;
  await page.getByRole('button', { name: /Next/ }).click();
  await expectHeading('Target Viewport & Advanced Settings');

  const unexpectedStart = requests.find((request) => request.method === 'POST' && /\/api\/runs$/.test(request.url));
  if (unexpectedStart) {
    throw new Error(`Step 3 Next created a run unexpectedly: ${unexpectedStart.body ?? ''}`);
  }

  await page.getByRole('button', { name: /Back/ }).click();
  await expectHeading('Testing Intelligence Mode');

  await page.getByRole('button', { name: /Next/ }).click();
  await expectHeading('Target Viewport & Advanced Settings');
  await page.getByRole('button', { name: /Advanced Crawler Limits/ }).click();
  await page.locator('.form-group').filter({ hasText: 'Max Pages' }).locator('input').fill('3');
  await page.locator('.form-group').filter({ hasText: 'Action Budget' }).locator('input').fill('40');
  await page.getByRole('button', { name: /Back/ }).click();
  await page.getByRole('button', { name: /Next/ }).click();

  const maxPages = await page.locator('.form-group').filter({ hasText: 'Max Pages' }).locator('input').inputValue();
  const actionBudget = await page.locator('.form-group').filter({ hasText: 'Action Budget' }).locator('input').inputValue();
  if (maxPages !== '3' || actionBudget !== '40') {
    throw new Error(`Wizard values did not persist. maxPages=${maxPages} actionBudget=${actionBudget}`);
  }

  if (createRun) {
    requests.length = 0;
    await Promise.all([
      page.waitForRequest((request) => request.method() === 'POST' && /\/api\/runs$/.test(request.url()), { timeout: 8000 }),
      page.getByRole('button', { name: /Start Autonomous QA Test/ }).click(),
    ]);
    await page.getByText(/RUNNING|Run finished|STOP TEST/).first().waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: /STOP TEST/ }).click({ timeout: 3000 }).catch(() => undefined);
  }

  console.log('Wizard navigation regression check passed.');
} finally {
  await browser.close();
}

async function expectHeading(text) {
  await page.locator('.wizard-step-copy h3', { hasText: text }).waitFor();
}
