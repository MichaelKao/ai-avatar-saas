import { describe, it, expect } from 'vitest';

describe('登入表單驗證', () => {
  it('Email 格式驗證', () => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    expect(emailRegex.test('test@example.com')).toBe(true);
    expect(emailRegex.test('invalid')).toBe(false);
    expect(emailRegex.test('@example.com')).toBe(false);
  });

  it('密碼至少 8 字元', () => {
    expect('12345678'.length >= 8).toBe(true);
    expect('1234567'.length >= 8).toBe(false);
  });
});

describe('escapeHtml', () => {
  it('應該轉義 HTML 特殊字元', () => {
    const escapeHtml = (str: string): string => {
      const map: Record<string, string> = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;',
      };
      return str.replace(/[&<>"']/g, (m) => map[m]);
    };

    expect(escapeHtml('<script>alert("xss")</script>')).toBe(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'
    );
  });
});
