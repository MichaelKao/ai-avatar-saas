'use client';

import Link from 'next/link';

// Stripe 付款取消回調頁面
export default function BillingCancelPage() {
  return (
    <div className="max-w-lg mx-auto px-4 sm:px-8 py-16 text-center">
      <div className="w-20 h-20 mx-auto mb-6 bg-yellow-100 rounded-full flex items-center justify-center">
        <svg className="w-10 h-10 text-yellow-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </div>
      <h2 className="text-2xl font-bold mb-2">付款已取消</h2>
      <p className="text-gray-500 mb-8">
        你已取消付款流程。如果有任何疑問，歡迎隨時再回來選擇適合的方案。
      </p>
      <Link
        href="/billing"
        className="inline-block px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium"
      >
        返回訂閱方案
      </Link>
    </div>
  );
}
