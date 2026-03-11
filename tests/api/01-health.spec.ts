import { test, expect } from '@playwright/test';

test.describe('健康檢查', () => {
  test('GET /health 回傳 200', async ({ request }) => {
    const res = await request.get('/health');
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.status).toBe('ok');
  });

  test('GET /health/ready 深度檢查', async ({ request }) => {
    const res = await request.get('/health/ready');
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.database).toBe('connected');
    expect(body.redis).toBe('connected');
  });
});
