import { test, expect } from '@playwright/test';

const API_BASE = '/api/v1';

/**
 * 註冊新用戶並登入，回傳 token
 */
async function registerAndLogin(
  request: any,
  overrides: { email?: string; password?: string; name?: string } = {},
) {
  const email = overrides.email || `test_${Date.now()}@example.com`;
  const password = overrides.password || 'TestPass123!';
  const name = overrides.name || 'Test User';

  const registerRes = await request.post(`${API_BASE}/auth/register`, {
    data: { email, password, name },
  });

  // 註冊可能回傳 201（新建）或 200
  const registerStatus = registerRes.status();
  expect([200, 201].includes(registerStatus)).toBeTruthy();

  const registerBody = await registerRes.json();
  const token = registerBody.data?.token;
  expect(token).toBeTruthy();

  return { email, password, name, token };
}

test.describe('認證 API', () => {
  test('POST /auth/register 正常註冊 → 201', async ({ request }) => {
    const email = `reg_${Date.now()}@example.com`;
    const res = await request.post(`${API_BASE}/auth/register`, {
      data: {
        email,
        password: 'ValidPass123!',
        name: 'New User',
      },
    });

    expect([200, 201].includes(res.status())).toBeTruthy();

    const body = await res.json();
    expect(body.data).toBeTruthy();
    expect(body.data.user).toBeTruthy();
    expect(body.data.user.email).toBe(email);
    expect(body.data.token).toBeTruthy();
    expect(body.error).toBeNull();
  });

  test('POST /auth/register 重複 email → 409', async ({ request }) => {
    const email = `dup_${Date.now()}@example.com`;

    // 先註冊一次
    await request.post(`${API_BASE}/auth/register`, {
      data: { email, password: 'ValidPass123!', name: 'First' },
    });

    // 再用相同 email 註冊
    const res = await request.post(`${API_BASE}/auth/register`, {
      data: { email, password: 'ValidPass123!', name: 'Second' },
    });

    expect(res.status()).toBe(409);

    const body = await res.json();
    expect(body.error).toBeTruthy();
    expect(body.data).toBeNull();
  });

  test('POST /auth/register 密碼太短 → 400', async ({ request }) => {
    const res = await request.post(`${API_BASE}/auth/register`, {
      data: {
        email: `short_${Date.now()}@example.com`,
        password: '123',
        name: 'Short Pass',
      },
    });

    expect(res.status()).toBe(400);

    const body = await res.json();
    expect(body.error).toBeTruthy();
  });

  test('POST /auth/login 正確密碼 → 200 + token', async ({ request }) => {
    const email = `login_${Date.now()}@example.com`;
    const password = 'LoginPass123!';

    // 先註冊
    await request.post(`${API_BASE}/auth/register`, {
      data: { email, password, name: 'Login User' },
    });

    // 登入
    const res = await request.post(`${API_BASE}/auth/login`, {
      data: { email, password },
    });

    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.data).toBeTruthy();
    expect(body.data.token).toBeTruthy();
    expect(body.data.user).toBeTruthy();
    expect(body.data.user.email).toBe(email);
    expect(body.error).toBeNull();
  });

  test('POST /auth/login 錯誤密碼 → 401', async ({ request }) => {
    const email = `wrong_${Date.now()}@example.com`;

    // 先註冊
    await request.post(`${API_BASE}/auth/register`, {
      data: { email, password: 'CorrectPass123!', name: 'Wrong Pass' },
    });

    // 用錯誤密碼登入
    const res = await request.post(`${API_BASE}/auth/login`, {
      data: { email, password: 'WrongPassword!' },
    });

    expect(res.status()).toBe(401);

    const body = await res.json();
    expect(body.error).toBeTruthy();
  });

  test('POST /auth/login 連續 5 次失敗 → 403 鎖定', async ({ request }) => {
    const email = `lock_${Date.now()}@example.com`;

    // 先註冊
    await request.post(`${API_BASE}/auth/register`, {
      data: { email, password: 'LockTestPass123!', name: 'Lock Test' },
    });

    // 連續 5 次錯誤密碼登入
    for (let i = 0; i < 5; i++) {
      await request.post(`${API_BASE}/auth/login`, {
        data: { email, password: `WrongPass${i}` },
      });
    }

    // 第 6 次嘗試（即使用正確密碼）應該被鎖定
    const res = await request.post(`${API_BASE}/auth/login`, {
      data: { email, password: 'LockTestPass123!' },
    });

    expect(res.status()).toBe(403);

    const body = await res.json();
    expect(body.error).toBeTruthy();
  });

  test('無 token 存取保護路由 → 401', async ({ request }) => {
    const res = await request.get(`${API_BASE}/avatar/profile`);

    expect(res.status()).toBe(401);

    const body = await res.json();
    expect(body.error).toBeTruthy();
  });

  test('有效 token 存取保護路由 → 200', async ({ request }) => {
    const { token } = await registerAndLogin(request);

    const res = await request.get(`${API_BASE}/avatar/profile`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    // 應該可以正常存取（200 或 201 自動建立）
    expect([200, 201].includes(res.status())).toBeTruthy();

    const body = await res.json();
    expect(body.data).toBeTruthy();
  });
});
