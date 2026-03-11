import { create } from 'zustand';

export interface AiSuggestion {
  id: string;
  text: string;
  timestamp: number;
  audioUrl?: string;
  videoUrl?: string;
}

interface SessionState {
  sessionId: string | null;
  status: 'idle' | 'connecting' | 'active' | 'ended';
  wsConnected: boolean;
  suggestions: AiSuggestion[];
  startTime: number | null;
  mode: 1 | 2 | 3;

  setSession: (sessionId: string) => void;
  setStatus: (status: SessionState['status']) => void;
  setWsConnected: (connected: boolean) => void;
  addSuggestion: (suggestion: AiSuggestion) => void;
  clearSuggestions: () => void;
  setStartTime: (time: number | null) => void;
  setMode: (mode: 1 | 2 | 3) => void;
  reset: () => void;
}

export const useSessionStore = create<SessionState>((set) => ({
  sessionId: null,
  status: 'idle',
  wsConnected: false,
  suggestions: [],
  startTime: null,
  mode: 1,

  setSession: (sessionId) => set({ sessionId }),
  setStatus: (status) => set({ status }),
  setWsConnected: (connected) => set({ wsConnected: connected }),
  setMode: (mode) => set({ mode }),
  addSuggestion: (suggestion) =>
    set((state) => ({
      suggestions: [...state.suggestions, suggestion],
    })),
  clearSuggestions: () => set({ suggestions: [] }),
  setStartTime: (time) => set({ startTime: time }),
  reset: () =>
    set({
      sessionId: null,
      status: 'idle',
      wsConnected: false,
      suggestions: [],
      startTime: null,
      mode: 1,
    }),
}));
