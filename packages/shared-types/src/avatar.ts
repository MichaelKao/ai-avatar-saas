// 用戶
export interface User {
  id: string;
  email: string;
  name: string | null;
  plan: 'free' | 'starter' | 'pro' | 'elite' | 'enterprise';
  created_at: string;
  updated_at: string;
}

// Avatar 設定
export interface AvatarProfile {
  id: string;
  user_id: string;
  face_image_url: string | null;
  voice_sample_url: string | null;
  voice_model_id: string | null;
  face_model_status: 'pending' | 'processing' | 'ready' | 'failed';
  voice_model_status: 'pending' | 'processing' | 'ready' | 'failed';
  created_at: string;
  updated_at: string;
}

// AI 個性設定
export interface AiPersonality {
  id: string;
  user_id: string;
  name: string;
  system_prompt: string;
  llm_model: string;
  temperature: number;
  language: string;
  is_default: boolean;
  created_at: string;
}

// 會議模式
export type MeetingMode = 'prompt' | 'avatar' | 'full';

// 會議 Session
export interface MeetingSession {
  id: string;
  user_id: string;
  mode: MeetingMode;
  started_at: string;
  ended_at: string | null;
  duration_seconds: number | null;
  total_responses: number;
  llm_model_used: string;
}
