import { test, expect } from '@playwright/test';

const API_BASE = '/api/v1';

/**
 * 註冊新用戶並登入，回傳 token
 */
async function registerAndLogin(request: any) {
  const email = `personality_${Date.now()}@example.com`;
  const password = 'PersonalityPass123!';

  const registerRes = await request.post(`${API_BASE}/auth/register`, {
    data: { email, password, name: 'Personality Test User' },
  });

  const body = await registerRes.json();
  return body.data?.token as string;
}

test.describe('Personality API', () => {
  let token: string;
  let personalityId: string;

  test.beforeAll(async ({ request }) => {
    token = await registerAndLogin(request);
    expect(token).toBeTruthy();
  });

  test('POST /personalities 建立人設 → 201', async ({ request }) => {
    const res = await request.post(`${API_BASE}/personalities`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        name: `測試人設_${Date.now()}`,
        system_prompt: '你是一位專業的商業顧問，回答簡潔有力。',
        language: 'zh-TW',
        voice_style: 'professional',
      },
    });

    expect([200, 201].includes(res.status())).toBeTruthy();

    const body = await res.json();
    expect(body.data).toBeTruthy();
    expect(body.data.id).toBeTruthy();
    expect(body.error).toBeNull();

    personalityId = body.data.id;
  });

  test('GET /personalities 列出人設 → 200', async ({ request }) => {
    const res = await request.get(`${API_BASE}/personalities`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.data).toBeTruthy();
    expect(Array.isArray(body.data)).toBeTruthy();
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    expect(body.error).toBeNull();
  });

  test('PUT /personalities/:id 更新人設 → 200', async ({ request }) => {
    expect(personalityId).toBeTruthy();

    const res = await request.put(`${API_BASE}/personalities/${personalityId}`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        name: `更新人設_${Date.now()}`,
        system_prompt: '你是一位友善的助理，使用繁體中文回答。',
      },
    });

    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.data).toBeTruthy();
    expect(body.error).toBeNull();
  });

  test('PUT /personalities/:id/default 設為預設 → 200', async ({ request }) => {
    expect(personalityId).toBeTruthy();

    const res = await request.put(
      `${API_BASE}/personalities/${personalityId}/default`,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );

    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.data).toBeTruthy();
    expect(body.error).toBeNull();
  });

  test('DELETE /personalities/:id 刪除人設 → 200', async ({ request }) => {
    expect(personalityId).toBeTruthy();

    const res = await request.delete(
      `${API_BASE}/personalities/${personalityId}`,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );

    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.data).toBeTruthy();
    expect(body.error).toBeNull();
  });
});
