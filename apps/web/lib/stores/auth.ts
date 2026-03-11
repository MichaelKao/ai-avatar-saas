import { create } from 'zustand';

interface User {
  id: string;
  email: string;
  name: string | null;
  plan: string;
}

interface AuthState {
  user: User | null;
  token: string | null;
  setAuth: (user: User, token: string) => void;
  setUser: (user: User) => void;
  logout: () => void;
  refreshToken: () => Promise<boolean>;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: typeof window !== 'undefined'
    ? (() => { try { return JSON.parse(localStorage.getItem('auth-user') || 'null'); } catch { return null; } })()
    : null,
  token: typeof window !== 'undefined'
    ? localStorage.getItem('auth-token')
    : null,

  setAuth: (user, token) => {
    localStorage.setItem('auth-user', JSON.stringify(user));
    localStorage.setItem('auth-token', token);
    set({ user, token });
  },

  setUser: (user) => {
    localStorage.setItem('auth-user', JSON.stringify(user));
    set({ user });
  },

  logout: () => {
    localStorage.removeItem('auth-user');
    localStorage.removeItem('auth-token');
    set({ user: null, token: null });
  },

  refreshToken: async () => {
    const currentToken = get().token;
    if (!currentToken) return false;

    try {
      const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080';
      const res = await fetch(`${API_URL}/api/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: currentToken }),
      });

      if (!res.ok) return false;

      const body = await res.json();
      const newToken = body.data?.token;
      if (newToken) {
        localStorage.setItem('auth-token', newToken);
        set({ token: newToken });
        return true;
      }
      return false;
    } catch {
      return false;
    }
  },
}));
