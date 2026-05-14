'use client';

import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine, Legend
} from 'recharts';

interface BackendMetrics {
  requestsTotal: number;
  requestsFailed: number;
  avgResponseTime: number;
  p95ResponseTime: number;
  p99ResponseTime: number;
  rps: number;
}

export default function BackendChart({ metrics }: { metrics: BackendMetrics }) {
  const responseTimeData = [
    { name: 'Avg', value: Math.round(metrics.avgResponseTime), fill: '#3b82f6' },
    { name: 'p95', value: Math.round(metrics.p95ResponseTime), fill: '#f59e0b' },
    { name: 'p99', value: Math.round(metrics.p99ResponseTime), fill: '#ef4444' },
  ];

  const requestsData = [
    { name: 'Successful', value: metrics.requestsTotal - metrics.requestsFailed, fill: '#22c55e' },
    { name: 'Failed', value: metrics.requestsFailed, fill: '#ef4444' },
  ];

  const errorRate = metrics.requestsTotal > 0
    ? ((metrics.requestsFailed / metrics.requestsTotal) * 100).toFixed(2)
    : '0';

  return (
    <div className="space-y-6">

      {/* Response Time */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-medium text-gray-700">Response Time</h3>
          <span className="text-xs text-gray-400">milliseconds</span>
        </div>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={responseTimeData} barSize={48}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
            <XAxis dataKey="name" tick={{ fontSize: 12 }} />
            <YAxis tick={{ fontSize: 12 }} unit="ms" />
            <Tooltip
              formatter={(value) => [`${value}ms`, 'Response time']}
              contentStyle={{ borderRadius: '8px', border: '1px solid #e5e7eb' }}
            />
            <ReferenceLine y={300} stroke="#ef4444" strokeDasharray="4 4" label={{ value: 'threshold 300ms', fontSize: 11, fill: '#ef4444' }} />
            <Bar dataKey="value" radius={[4, 4, 0, 0]}>
              {responseTimeData.map((entry, i) => (
                <rect key={i} fill={entry.fill} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Requests breakdown */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-medium text-gray-700">Requests breakdown</h3>
          <span className="text-xs text-gray-400">Error rate: {errorRate}%</span>
        </div>
        <ResponsiveContainer width="100%" height={160}>
          <BarChart data={requestsData} barSize={64}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
            <XAxis dataKey="name" tick={{ fontSize: 12 }} />
            <YAxis tick={{ fontSize: 12 }} />
            <Tooltip
              contentStyle={{ borderRadius: '8px', border: '1px solid #e5e7eb' }}
            />
            <Bar dataKey="value" radius={[4, 4, 0, 0]}>
              {requestsData.map((entry, i) => (
                <rect key={i} fill={entry.fill} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* RPS */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <h3 className="text-sm font-medium text-gray-700 mb-2">Throughput</h3>
        <div className="flex items-end gap-2">
          <span className="text-4xl font-bold text-gray-900">{metrics.rps?.toFixed(1)}</span>
          <span className="text-gray-500 mb-1">requests/sec</span>
        </div>
        <div className="mt-3 h-2 bg-gray-100 rounded-full overflow-hidden">
          <div
            className="h-full bg-blue-500 rounded-full transition-all"
            style={{ width: `${Math.min(100, (metrics.rps / 100) * 100)}%` }}
          />
        </div>
        <p className="text-xs text-gray-400 mt-1">relative to 100 rps baseline</p>
      </div>

    </div>
  );
}