import { test as base, expect } from '@playwright/test';

// 共用 fixture — 監控 HTTP 500+ 錯誤和 console.error
export const test = base.extend({
  page: async ({ page }, use) => {
    const errors: string[] = [];

    // 監控頁面錯誤
    page.on('pageerror', (err) => {
      errors.push(`Page Error: ${err.message}`);
    });

    // 監控 HTTP 500+ 錯誤
    page.on('response', (res) => {
      if (res.status() >= 500) {
        errors.push(`HTTP ${res.status()}: ${res.url()}`);
      }
    });

    await use(page);

    // 測試結束後檢查是否有錯誤
    expect(errors, 'Page errors detected during test').toEqual([]);
  },
});

export { expect };
