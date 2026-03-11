// 訂閱方案
export type PlanType = 'free' | 'starter' | 'pro' | 'elite' | 'enterprise';

export interface Plan {
  id: PlanType;
  name: string;
  price: number;
  features: string[];
}

export interface Subscription {
  id: string;
  user_id: string;
  stripe_subscription_id: string;
  plan: PlanType;
  status: 'active' | 'canceled' | 'past_due' | 'trialing';
  current_period_start: string;
  current_period_end: string;
  created_at: string;
}

// 訂閱方案定義
export const PLANS: Plan[] = [
  {
    id: 'free',
    name: '免費',
    price: 0,
    features: ['模式1（每天30分鐘）', '預設 Avatar', '僅 Claude'],
  },
  {
    id: 'starter',
    name: '入門',
    price: 15,
    features: ['模式1 完整版', '自訂 AI 個性', '選擇模型'],
  },
  {
    id: 'pro',
    name: '專業',
    price: 39,
    features: ['模式1+2', '上傳臉/聲音', '換背景', '優先佇列'],
  },
  {
    id: 'elite',
    name: '旗艦',
    price: 79,
    features: ['模式1+2+3', '換裝', '所有模型', '最低延遲', 'API'],
  },
  {
    id: 'enterprise',
    name: '企業',
    price: 199,
    features: ['無限帳號', '客製化部署', '專屬支援', 'SLA'],
  },
];
