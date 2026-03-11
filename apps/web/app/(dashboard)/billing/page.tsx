'use client';

import { api } from '@/lib/api';
import { useQuery, useMutation } from '@tanstack/react-query';
import { useAuthStore } from '@/lib/stores/auth';
import { escapeHtml } from '@/lib/utils';
import { toast } from '@/components/Toast';

interface BillingStatus {
  plan: string;
  status: string;
  current_period_end: string | null;
  usage_this_month: {
    sessions: number;
    total_minutes: number;
    suggestions: number;
  };
}

const plans = [
  {
    key: 'free',
    name: '免費',
    price: '$0',
    features: ['每日 30 分鐘會議時間', '基本 AI 個性', '標準畫質'],
  },
  {
    key: 'pro',
    name: '專業',
    price: '$29',
    features: ['無限會議時間', '自訂 AI 個性', '高畫質串流', '語音克隆', '優先技術支援'],
    popular: true,
  },
  {
    key: 'enterprise',
    name: '企業',
    price: '$99',
    features: ['Pro 方案所有功能', '多人同時使用', 'API 存取', '自訂模型訓練', '專屬客戶經理', 'SLA 保證'],
  },
];

export default function BillingPage() {
  const { user } = useAuthStore();

  const { data: billing, isLoading } = useQuery<BillingStatus>({
    queryKey: ['billing-status'],
    queryFn: () => api.get('/api/v1/billing/status').then((r) => r.data),
  });

  const subscribeMutation = useMutation({
    mutationFn: (planKey: string) =>
      api.post('/api/v1/billing/subscribe', { plan_id: planKey }),
    onSuccess: (data) => {
      // Stripe checkout URL
      if (data?.data?.checkout_url) {
        window.location.href = data.data.checkout_url;
      } else {
        toast.success('訂閱處理中...');
      }
    },
    onError: (err: any) => {
      toast.error(err.response?.data?.error || '訂閱失敗');
    },
  });

  const cancelMutation = useMutation({
    mutationFn: () => api.post('/api/v1/billing/cancel'),
    onSuccess: () => {
      toast.success('訂閱已取消，將在本期結束後生效');
    },
    onError: (err: any) => {
      toast.error(err.response?.data?.error || '取消失敗');
    },
  });

  const portalMutation = useMutation({
    mutationFn: () => api.post('/api/v1/billing/portal'),
    onSuccess: (data) => {
      if (data?.data?.portal_url) {
        window.location.href = data.data.portal_url;
      }
    },
    onError: (err: any) => {
      toast.error(err.response?.data?.error || '無法開啟帳單管理');
    },
  });

  const currentPlan = billing?.plan || user?.plan || 'free';

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-8 py-8">
      <h2 className="text-2xl font-bold mb-2">訂閱方案</h2>

      {/* 目前狀態 */}
      {billing && currentPlan !== 'free' && (
        <div className="bg-white rounded-xl shadow-sm border p-5 mb-8">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div>
              <p className="text-sm text-gray-600">
                目前方案：
                <span className="font-bold text-gray-900 ml-1">
                  {escapeHtml(
                    plans.find((p) => p.key === currentPlan)?.name || currentPlan
                  )}
                </span>
              </p>
              {billing.current_period_end && (
                <p className="text-sm text-gray-500 mt-1">
                  {billing.status === 'canceling'
                    ? '將於本期結束後取消'
                    : `下次續費：${new Date(billing.current_period_end).toLocaleDateString('zh-TW')}`}
                </p>
              )}
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => portalMutation.mutate()}
                disabled={portalMutation.isPending}
                className="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 text-sm font-medium disabled:opacity-50"
              >
                管理帳單
              </button>
              {billing.status !== 'canceling' && (
                <button
                  onClick={() => {
                    if (window.confirm('確定要取消訂閱嗎？')) {
                      cancelMutation.mutate();
                    }
                  }}
                  disabled={cancelMutation.isPending}
                  className="px-4 py-2 border border-red-300 text-red-600 rounded-lg hover:bg-red-50 text-sm font-medium disabled:opacity-50"
                >
                  {cancelMutation.isPending ? '取消中...' : '取消訂閱'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      <p className="text-gray-600 mb-6">選擇最適合你的方案</p>

      {/* 方案卡片 */}
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
        {plans.map((plan) => {
          const isCurrent = plan.key === currentPlan;
          return (
            <div
              key={plan.key}
              className={`p-6 bg-white rounded-xl shadow-sm border flex flex-col ${
                plan.popular
                  ? 'border-blue-500 ring-2 ring-blue-200'
                  : isCurrent
                  ? 'border-green-400 ring-1 ring-green-200'
                  : ''
              }`}
            >
              <div className="flex items-center justify-between mb-1">
                {plan.popular && (
                  <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full font-medium">
                    最受歡迎
                  </span>
                )}
                {isCurrent && !plan.popular && (
                  <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-medium">
                    目前方案
                  </span>
                )}
                {isCurrent && plan.popular && (
                  <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-medium ml-1">
                    目前
                  </span>
                )}
              </div>
              <h3 className="text-xl font-bold mt-2">{plan.name}</h3>
              <div className="text-3xl font-bold my-3">
                {plan.price}
                <span className="text-sm text-gray-500 font-normal">/月</span>
              </div>
              <ul className="space-y-2 mb-6 flex-1">
                {plan.features.map((f) => (
                  <li
                    key={f}
                    className="text-sm text-gray-600 flex items-start"
                  >
                    <span className="text-green-500 mr-2 flex-shrink-0">
                      &#10003;
                    </span>
                    {escapeHtml(f)}
                  </li>
                ))}
              </ul>
              <button
                className={`w-full py-2 rounded-lg font-medium text-sm ${
                  isCurrent
                    ? 'bg-gray-100 text-gray-500 cursor-default'
                    : plan.key === 'free'
                    ? 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                    : 'bg-blue-600 text-white hover:bg-blue-700'
                } disabled:opacity-50`}
                disabled={isCurrent || subscribeMutation.isPending}
                onClick={() => {
                  if (!isCurrent && plan.key !== 'free') {
                    subscribeMutation.mutate(plan.key);
                  }
                }}
              >
                {isCurrent
                  ? '目前方案'
                  : subscribeMutation.isPending
                  ? '處理中...'
                  : plan.key === 'free'
                  ? '免費版'
                  : '升級'}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
