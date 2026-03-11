'use client';

import Link from 'next/link';

// Stripe 付款成功回調頁面
export default function BillingSuccessPage() {
  return (
    <div className="max-w-lg mx-auto px-4 sm:px-8 py-16 text-center">
      <div className="w-20 h-20 mx-auto mb-6 bg-green-100 rounded-full flex items-center justify-center">
        <svg className="w-10 h-10 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
      </div>
      <h2 className="text-2xl font-bold mb-2">訂閱成功！</h2>
      <p className="text-gray-500 mb-8">
        感謝你的訂閱，你的方案已生效。現在可以開始使用所有進階功能。
      </p>
      <div className="flex gap-3 justify-center">
        <Link
          href="/billing"
          className="px-6 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 text-sm font-medium"
        >
          查看訂閱狀態
        </Link>
        <Link
          href="/dashboard"
          className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium"
        >
          前往儀表板
        </Link>
      </div>
    </div>
  );
}
