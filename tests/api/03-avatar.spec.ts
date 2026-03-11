import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const API_BASE = '/api/v1';

/**
 * 註冊新用戶並登入，回傳 token
 */
async function registerAndLogin(request: any) {
  const email = `avatar_${Date.now()}@example.com`;
  const password = 'AvatarPass123!';

  const registerRes = await request.post(`${API_BASE}/auth/register`, {
    data: { email, password, name: 'Avatar Test User' },
  });

  const body = await registerRes.json();
  return body.data?.token as string;
}

test.describe('Avatar API', () => {
  let token: string;

  test.beforeAll(async ({ request }) => {
    token = await registerAndLogin(request);
    expect(token).toBeTruthy();
  });

  test('GET /avatar/profile 取得（自動建立）→ 200', async ({ request }) => {
    const res = await request.get(`${API_BASE}/avatar/profile`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    // 第一次存取會自動建立，所以 200 或 201 都算成功
    expect([200, 201].includes(res.status())).toBeTruthy();

    const body = await res.json();
    expect(body.data).toBeTruthy();
    expect(body.error).toBeNull();
    // 新建的 profile 應有基本欄位
    expect(body.data.user_id).toBeTruthy();
    expect(body.data.face_model_status).toBeTruthy();
  });

  test('POST /avatar/face 上傳臉部圖片 → 200', async ({ request }) => {
    // 建立一個最小的 1x1 PNG 測試檔案
    const pngBuffer = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
      0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41,
      0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
      0x00, 0x00, 0x02, 0x00, 0x01, 0xe2, 0x21, 0xbc,
      0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
      0x44, 0xae, 0x42, 0x60, 0x82,
    ]);

    const res = await request.post(`${API_BASE}/avatar/face`, {
      headers: { Authorization: `Bearer ${token}` },
      multipart: {
        face_image: {
          name: 'test_face.png',
          mimeType: 'image/png',
          buffer: pngBuffer,
        },
      },
    });

    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.data).toBeTruthy();
    expect(body.data.face_image_url).toBeTruthy();
    expect(body.data.face_model_status).toBe('processing');
    expect(body.error).toBeNull();
  });

  test('GET /avatar/model-status 取得模型狀態 → 200', async ({ request }) => {
    const res = await request.get(`${API_BASE}/avatar/model-status`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.data).toBeTruthy();
    expect(body.data.face_model_status).toBeTruthy();
    expect(body.data.voice_model_status).toBeTruthy();
    expect(body.error).toBeNull();
  });

  test('DELETE /avatar/profile 刪除設定檔 → 200', async ({ request }) => {
    const res = await request.delete(`${API_BASE}/avatar/profile`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.data).toBeTruthy();
    expect(body.error).toBeNull();
  });
});
