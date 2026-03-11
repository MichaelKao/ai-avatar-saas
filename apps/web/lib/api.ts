import { useAuthStore } from '@/lib/stores/auth';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080';

export interface ApiError {
  response: {
    data: { error: string; message?: string };
    status: number;
  };
}

// 不需要 token refresh 的路徑（避免無限迴圈）
const AUTH_PATHS = [
  '/api/v1/auth/login',
  '/api/v1/auth/register',
  '/api/v1/auth/forgot-password',
  '/api/v1/auth/reset-password',
  '/api/v1/auth/refresh',
];

class ApiClient {
  private baseURL: string;
  private isRefreshing = false;
  private refreshPromise: Promise<boolean> | null = null;

  constructor(baseURL: string) {
    this.baseURL = baseURL;
  }

  private getHeaders(json = true): HeadersInit {
    const headers: HeadersInit = {};

    if (json) {
      headers['Content-Type'] = 'application/json';
    }

    // 從 localStorage 取得 token（客戶端）
    if (typeof window !== 'undefined') {
      const token = localStorage.getItem('auth-token');
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
    }

    return headers;
  }

  private isAuthPath(path: string): boolean {
    return AUTH_PATHS.some((p) => path.startsWith(p));
  }

  private async handleUnauthorized(path: string): Promise<boolean> {
    // 不要在 auth 路徑上嘗試 refresh
    if (this.isAuthPath(path)) return false;
    if (typeof window === 'undefined') return false;

    // 如果已經在 refreshing，等待結果
    if (this.isRefreshing && this.refreshPromise) {
      return this.refreshPromise;
    }

    this.isRefreshing = true;
    this.refreshPromise = useAuthStore.getState().refreshToken();

    try {
      const success = await this.refreshPromise;
      if (!success) {
        useAuthStore.getState().logout();
        window.location.href = '/login';
        return false;
      }
      return true;
    } finally {
      this.isRefreshing = false;
      this.refreshPromise = null;
    }
  }

  async get(path: string) {
    const res = await fetch(`${this.baseURL}${path}`, {
      headers: this.getHeaders(),
    });

    if (res.status === 401) {
      const refreshed = await this.handleUnauthorized(path);
      if (refreshed) {
        const retryRes = await fetch(`${this.baseURL}${path}`, {
          headers: this.getHeaders(),
        });
        const retryBody = await retryRes.json();
        if (!retryRes.ok) {
          throw { response: { data: retryBody, status: retryRes.status } } as ApiError;
        }
        return retryBody;
      }
    }

    const body = await res.json();

    if (!res.ok) {
      throw { response: { data: body, status: res.status } } as ApiError;
    }

    return body;
  }

  async post(path: string, data?: unknown) {
    const res = await fetch(`${this.baseURL}${path}`, {
      method: 'POST',
      headers: this.getHeaders(),
      body: data ? JSON.stringify(data) : undefined,
    });

    if (res.status === 401) {
      const refreshed = await this.handleUnauthorized(path);
      if (refreshed) {
        const retryRes = await fetch(`${this.baseURL}${path}`, {
          method: 'POST',
          headers: this.getHeaders(),
          body: data ? JSON.stringify(data) : undefined,
        });
        const retryBody = await retryRes.json();
        if (!retryRes.ok) {
          throw { response: { data: retryBody, status: retryRes.status } } as ApiError;
        }
        return retryBody;
      }
    }

    const body = await res.json();

    if (!res.ok) {
      throw { response: { data: body, status: res.status } } as ApiError;
    }

    return body;
  }

  async put(path: string, data?: unknown) {
    const res = await fetch(`${this.baseURL}${path}`, {
      method: 'PUT',
      headers: this.getHeaders(),
      body: data ? JSON.stringify(data) : undefined,
    });

    if (res.status === 401) {
      const refreshed = await this.handleUnauthorized(path);
      if (refreshed) {
        const retryRes = await fetch(`${this.baseURL}${path}`, {
          method: 'PUT',
          headers: this.getHeaders(),
          body: data ? JSON.stringify(data) : undefined,
        });
        const retryBody = await retryRes.json();
        if (!retryRes.ok) {
          throw { response: { data: retryBody, status: retryRes.status } } as ApiError;
        }
        return retryBody;
      }
    }

    const body = await res.json();

    if (!res.ok) {
      throw { response: { data: body, status: res.status } } as ApiError;
    }

    return body;
  }

  async delete(path: string) {
    const res = await fetch(`${this.baseURL}${path}`, {
      method: 'DELETE',
      headers: this.getHeaders(),
    });

    if (res.status === 401) {
      const refreshed = await this.handleUnauthorized(path);
      if (refreshed) {
        const retryRes = await fetch(`${this.baseURL}${path}`, {
          method: 'DELETE',
          headers: this.getHeaders(),
        });
        const retryBody = await retryRes.json();
        if (!retryRes.ok) {
          throw { response: { data: retryBody, status: retryRes.status } } as ApiError;
        }
        return retryBody;
      }
    }

    const body = await res.json();

    if (!res.ok) {
      throw { response: { data: body, status: res.status } } as ApiError;
    }

    return body;
  }

  async upload(path: string, file: File, fieldName: string) {
    const formData = new FormData();
    formData.append(fieldName, file);

    const res = await fetch(`${this.baseURL}${path}`, {
      method: 'POST',
      headers: this.getHeaders(false),
      body: formData,
    });

    if (res.status === 401) {
      const refreshed = await this.handleUnauthorized(path);
      if (refreshed) {
        const retryFormData = new FormData();
        retryFormData.append(fieldName, file);
        const retryRes = await fetch(`${this.baseURL}${path}`, {
          method: 'POST',
          headers: this.getHeaders(false),
          body: retryFormData,
        });
        const retryBody = await retryRes.json();
        if (!retryRes.ok) {
          throw { response: { data: retryBody, status: retryRes.status } } as ApiError;
        }
        return retryBody;
      }
    }

    const body = await res.json();

    if (!res.ok) {
      throw { response: { data: body, status: res.status } } as ApiError;
    }

    return body;
  }
}

export const api = new ApiClient(API_URL);
