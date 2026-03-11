import { test, expect } from '@playwright/test';

const API_BASE = '/api/v1';

/**
 * 註冊新用戶並登入，回傳 token
 */
async function registerAndLogin(request: any) {
  const email = `billing_${Date.now()}@example.com`;
  const password = 'BillingPass123!';

  const registerRes = await request.post(`${API_BASE}/auth/register`, {
    data: { email, password, name: 'Billing Test User' },
  });

  const body = await registerRes.json();
  return body.data?.token as string;
}

test.describe('Billing API', () => {
  let token: string;

  test.beforeAll(async ({ request }) => {
    token = await registerAndLogin(request);
    expect(token).toBeTruthy();
  });

  test('GET /billing/plans 取得方案列表 → 200', async ({ request }) => {
    const res = await request.get(`${API_BASE}/billing/plans`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.data).toBeTruthy();
    expect(Array.isArray(body.data)).toBeTruthy();
    expect(body.error).toBeNull();

    // 至少有一個方案
    if (body.data.length > 0) {
      const plan = body.data[0];
      expect(plan.id).toBeTruthy();
      expect(plan.name).toBeTruthy();
    }
  });

  test('GET /billing/status 取得帳單狀態 → 200', async ({ request }) => {
    const res = await request.get(`${API_BASE}/billing/status`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.data).toBeTruthy();
    expect(body.error).toBeNull();

    // 新用戶應該是免費方案
    expect(body.data.plan).toBeTruthy();
  });
});
