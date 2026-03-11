const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080';

export interface ApiError {
  response: {
    data: { error: string; message?: string };
    status: number;
  };
}

class ApiClient {
  private baseURL: string;

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

  async get(path: string) {
    const res = await fetch(`${this.baseURL}${path}`, {
      headers: this.getHeaders(),
    });

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

    const body = await res.json();

    if (!res.ok) {
      throw { response: { data: body, status: res.status } } as ApiError;
    }

    return body;
  }
}

export const api = new ApiClient(API_URL);
