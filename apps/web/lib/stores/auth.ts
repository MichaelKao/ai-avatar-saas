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
  logout: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: typeof window !== 'undefined'
    ? JSON.parse(localStorage.getItem('auth-user') || 'null')
    : null,
  token: typeof window !== 'undefined'
    ? localStorage.getItem('auth-token')
    : null,

  setAuth: (user, token) => {
    localStorage.setItem('auth-user', JSON.stringify(user));
    localStorage.setItem('auth-token', token);
    set({ user, token });
  },

  logout: () => {
    localStorage.removeItem('auth-user');
    localStorage.removeItem('auth-token');
    set({ user: null, token: null });
  },
}));
