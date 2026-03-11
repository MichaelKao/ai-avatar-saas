import { test, expect } from '@playwright/test';

const API_BASE = '/api/v1';

/**
 * 註冊新用戶並登入，回傳 token
 */
async function registerAndLogin(request: any) {
  const email = `session_${Date.now()}@example.com`;
  const password = 'SessionPass123!';

  const registerRes = await request.post(`${API_BASE}/auth/register`, {
    data: { email, password, name: 'Session Test User' },
  });

  const body = await registerRes.json();
  return body.data?.token as string;
}

test.describe('Session API', () => {
  let token: string;
  let sessionId: string;

  test.beforeAll(async ({ request }) => {
    token = await registerAndLogin(request);
    expect(token).toBeTruthy();
  });

  test('POST /sessions 開始會議 → 201', async ({ request }) => {
    const res = await request.post(`${API_BASE}/sessions`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        title: `測試會議_${Date.now()}`,
        mode: 'prompt',
        meeting_url: 'https://meet.google.com/test-meeting',
      },
    });

    expect([200, 201].includes(res.status())).toBeTruthy();

    const body = await res.json();
    expect(body.data).toBeTruthy();
    expect(body.data.id).toBeTruthy();
    expect(body.error).toBeNull();

    sessionId = body.data.id;
  });

  test('PUT /sessions/:id/end 結束會議 → 200', async ({ request }) => {
    expect(sessionId).toBeTruthy();

    const res = await request.put(`${API_BASE}/sessions/${sessionId}/end`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.data).toBeTruthy();
    expect(body.error).toBeNull();
  });

  test('GET /sessions 取得會議歷史 → 200', async ({ request }) => {
    const res = await request.get(`${API_BASE}/sessions`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.data).toBeTruthy();
    expect(Array.isArray(body.data)).toBeTruthy();
    // 至少有一筆剛才建立的會議
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    expect(body.error).toBeNull();
  });
});
