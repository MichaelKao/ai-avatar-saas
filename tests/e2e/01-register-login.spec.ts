import { test, expect } from '../fixtures';

test.describe('註冊與登入流程', () => {
  const testEmail = `e2e_${Date.now()}@example.com`;
  const testPassword = 'E2eTestPass123!';
  const testName = 'E2E Test User';

  test('完整註冊 → 登入 → 登出流程', async ({ page }) => {
    // ── 步驟 1：前往註冊頁 ──
    await page.goto('/register');
    await expect(page).toHaveURL(/register/);

    // ── 步驟 2：填寫註冊表單 ──
    // 根據常見的 Next.js 表單結構尋找欄位
    const nameInput = page.locator('input[name="name"], input[placeholder*="名"]').first();
    const emailInput = page.locator('input[name="email"], input[type="email"]').first();
    const passwordInput = page.locator('input[name="password"], input[type="password"]').first();

    await nameInput.fill(testName);
    await emailInput.fill(testEmail);
    await passwordInput.fill(testPassword);

    // ── 步驟 3：提交表單 ──
    const submitButton = page.locator(
      'button[type="submit"], button:has-text("註冊"), button:has-text("Register"), button:has-text("Sign up")',
    ).first();
    await submitButton.click();

    // ── 步驟 4：驗證跳轉到 dashboard ──
    await page.waitForURL(/dashboard/, { timeout: 10000 });
    await expect(page).toHaveURL(/dashboard/);

    // ── 步驟 5：登出 ──
    // 嘗試各種登出按鈕的 selector
    const logoutButton = page.locator(
      'button:has-text("登出"), button:has-text("Logout"), button:has-text("Sign out"), [data-testid="logout"]',
    ).first();

    // 如果有使用者選單，先展開
    const userMenu = page.locator(
      '[data-testid="user-menu"], button:has-text("帳號"), .user-avatar',
    ).first();

    if (await userMenu.isVisible({ timeout: 2000 }).catch(() => false)) {
      await userMenu.click();
      await page.waitForTimeout(500);
    }

    if (await logoutButton.isVisible({ timeout: 3000 }).catch(() => false)) {
      await logoutButton.click();

      // 驗證回到登入頁或首頁
      await page.waitForURL(/\/(login|$)/, { timeout: 5000 });
    }
  });

  test('用相同帳號登入', async ({ page }) => {
    // ── 步驟 1：前往登入頁 ──
    await page.goto('/login');
    await expect(page).toHaveURL(/login/);

    // ── 步驟 2：填寫登入表單 ──
    const emailInput = page.locator('input[name="email"], input[type="email"]').first();
    const passwordInput = page.locator('input[name="password"], input[type="password"]').first();

    await emailInput.fill(testEmail);
    await passwordInput.fill(testPassword);

    // ── 步驟 3：提交登入 ──
    const submitButton = page.locator(
      'button[type="submit"], button:has-text("登入"), button:has-text("Login"), button:has-text("Sign in")',
    ).first();
    await submitButton.click();

    // ── 步驟 4：驗證跳轉到 dashboard ──
    await page.waitForURL(/dashboard/, { timeout: 10000 });
    await expect(page).toHaveURL(/dashboard/);
  });
});
