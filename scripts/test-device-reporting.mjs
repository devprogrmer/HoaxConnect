import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createServer } from 'vite';
const require = createRequire(import.meta.url);
const { chromium, _electron } = require(process.env.HC_PLAYWRIGHT_MODULE || 'playwright');
const databaseUrl = process.env.HC_STAGE2F_TEST_DATABASE_URL;
assert.ok(databaseUrl, 'Set HC_STAGE2F_TEST_DATABASE_URL to an isolated database');
const database = new URL(databaseUrl);
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(database.hostname));
assert.match(decodeURIComponent(database.pathname), /(^|[-_/])test($|[-_])/i);
assert.equal(process.env.HC_COLLECT_LOCAL_DEVICE_REPORTS, '1',
  'Set HC_COLLECT_LOCAL_DEVICE_REPORTS=1 to consent to local-only hardware/application collection in this test');
const root = resolve('.');
const evidence = join(root, '.tmp/evidence');
mkdirSync(evidence, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), 'hc-electron-presence-'));
const password = 'Disposable-UI-Test-Password-123!';
const suffix = randomUUID().slice(0, 8);
const email = `device-ui-${suffix}@example.test`;
const adminEmail = `admin-ui-${suffix}@example.test`;
Object.assign(process.env, {
  NODE_ENV: 'test', DATABASE_URL: databaseUrl,
  DATABASE_SSL: 'false', LOG_LEVEL: 'silent', JWT_ACCESS_SECRET: 'a'.repeat(128),
  JWT_ISSUER: 'https://api.hoaxconnect.test', JWT_AUDIENCE: 'hoaxconnect-desktop',
  REFRESH_TOKEN_PEPPER: 'b'.repeat(128),
  REFRESH_RECOVERY_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  ADMIN_ALLOWED_ORIGINS: 'http://127.0.0.1:5177', EMAIL_VERIFICATION_REQUIRED: 'false',
});
const { buildApp } = await import('../backend/src/app.ts');
const { pool } = await import('../backend/src/db.ts');
const { hashPassword } = await import('../backend/src/security.ts');
let backend, adminServer, desktopServer, browser, electron;
let userId, adminId;
const errors = [];
try {
  backend = await buildApp();
  await backend.listen({ host: '127.0.0.1', port: 0 });
  const port = backend.server.address().port;
  adminServer = await createServer({ configFile: join(root, 'admin/vite.config.ts'),
    server: { port: 5177, strictPort: true, proxy: { '/api': { target: `http://127.0.0.1:${port}`, changeOrigin: true } } } });
  await adminServer.listen();
  desktopServer = await createServer({ configFile: join(root, 'vite.config.ts'), server: { host: 'localhost', port: 5173, strictPort: true } });
  await desktopServer.listen();
  const inserted = await pool.query('INSERT INTO admin_accounts (email,email_normalized,password_hash,role) VALUES ($1,$1,$2,\'admin\') RETURNING id', [adminEmail, await hashPassword(password)]);
  adminId = inserted.rows[0].id;
  const electronEnv = { ...process.env, HOAXCONNECT_BACKEND_URL: `http://127.0.0.1:${port}` };
  delete electronEnv.ELECTRON_RUN_AS_NODE;
  electron = await _electron.launch({ executablePath: join(root, 'node_modules/electron/dist/electron.exe'),
    args: [root, `--user-data-dir=${profile}`, '--disable-gpu'],
    env: electronEnv, timeout: 30_000 });
  const desktop = await electron.firstWindow();
  desktop.on('pageerror', e => errors.push(e.message));
  await desktop.waitForFunction(() => Boolean(window.hoax?.auth));
  const registration = await desktop.evaluate(async ({ email, password, suffix }) => window.hoax.auth.register({ email, username: `ui_${suffix}`, phone: '+15551234567', password }), { email, password, suffix });
  assert.equal(registration.ok, true, JSON.stringify(registration));
  userId = registration.state.user.id;
  const deviceId = registration.state.device.id;
  await desktop.reload();
  await desktop.getByRole('button', { name: 'Continue without diagnostics' }).click();
  await desktop.getByRole('button', { name: 'Settings', exact: true }).click();
  await desktop.getByRole('heading', { name: 'Device reporting' }).waitFor();
  for (const name of ['Share hardware details', 'Share connection diagnostics', 'Share open application names']) {
    const toggle = desktop.getByRole('switch', { name: new RegExp(name) });
    await toggle.check();
    await desktop.waitForFunction(() => !document.querySelector('.device-reporting-settings fieldset')?.disabled);
  }
  const report = (await pool.query('SELECT * FROM client_device_reports WHERE device_id=$1', [deviceId])).rows[0];
  assert.ok(report.hardware?.cpu);
  assert.ok(report.hardware?.memory_bytes > 0);
  assert.match(report.hardware?.hwid_sha256 || '', /^[a-f0-9]{64}$/);
  assert.ok(Array.isArray(report.applications));
  assert.ok(report.network);
  await desktop.locator('.device-reporting-settings').screenshot({ path: join(evidence, 'desktop-reporting-settings.png') });
  console.log('REAL_WINDOWS_COLLECTORS_AND_ELECTRON_IPC_PASSED');

  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://127.0.0.1:5177/admin/');
  await page.getByLabel('Email', { exact: true }).fill(adminEmail);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('button', { name: 'Users', exact: true }).click();
  await page.getByPlaceholder('Email, username or phone').fill(email);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByText(`ui_${suffix}`, { exact: true }).click();
  await page.getByText('App online', { exact: true }).waitFor();
  await page.getByText(report.hardware.hwid_sha256, { exact: true }).waitFor();
  await page.locator('.device-reports').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(evidence, 'admin-device-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => document.querySelector('.sidebar').getBoundingClientRect().right <= 0);
  await page.locator('.device-reports').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(evidence, 'admin-device-mobile.png'), fullPage: true, animations: 'disabled' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Mobile page overflow');
  for (const name of ['Share hardware details', 'Share connection diagnostics', 'Share open application names']) {
    await desktop.getByRole('switch', { name: new RegExp(name) }).uncheck();
    await desktop.waitForFunction(() => !document.querySelector('.device-reporting-settings fieldset')?.disabled);
  }
  await page.getByRole('button', { name: 'Refresh current view' }).click();
  await page.getByText(report.hardware.hwid_sha256, { exact: true }).waitFor({ state: 'detached' });
  await electron.close(); electron = null;
  await page.getByRole('button', { name: 'Refresh current view' }).click();
  await page.getByText('App closed', { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log('ADMIN_DESKTOP_MOBILE_AND_CONSENT_WITHDRAWAL_PASSED');
} finally {
  await electron?.close().catch(() => {});
  await browser?.close();
  await desktopServer?.close();
  await adminServer?.close();
  await backend?.close();
  if (userId) await pool.query('DELETE FROM users WHERE id=$1', [userId]);
  if (adminId) await pool.query('DELETE FROM admin_accounts WHERE id=$1', [adminId]);
  await pool.end();
  assert.ok(resolve(profile).startsWith(resolve(tmpdir()) + '\\hc-electron-presence-'));
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
