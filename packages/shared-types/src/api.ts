// API 統一回應格式
export interface ApiResponse<T = unknown> {
  data: T | null;
  error: string | null;
}

// 分頁
export interface PaginatedResponse<T> extends ApiResponse<T[]> {
  total: number;
  page: number;
  limit: number;
}

// WebSocket 訊息
export interface WSMessage<T = unknown> {
  type: string;
  payload: T;
}

// WebSocket 訊息類型
export type WSMessageType =
  | 'transcribed_text'
  | 'suggestion_text'
  | 'video_chunk'
  | 'thinking_animation'
  | 'error';
