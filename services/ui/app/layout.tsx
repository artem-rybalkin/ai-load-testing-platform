import type { Metadata } from "next";
import ActiveTests from '@/app/components/ActiveTests';
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: 'AI Load Testing Platform',
  description: 'AI-powered performance testing',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body suppressHydrationWarning>
        <nav className="bg-white border-b border-gray-200 px-4 py-3">
          <div className="max-w-5xl mx-auto flex items-center justify-between">
            <a href="/" className="font-semibold text-gray-900">⚡ AI Load Testing</a>
            <div className="flex gap-4">
              <a href="/" className="text-sm text-gray-600 hover:text-gray-900">New test</a>
              <a href="/results" className="text-sm text-gray-600 hover:text-gray-900">Results</a>
              <a href="/schedules" className="text-sm text-gray-600 hover:text-gray-900">Schedules</a>
              <a href="/templates" className="text-sm text-gray-600 hover:text-gray-900">Templates</a>
              <a href="/webhooks" className="text-sm text-gray-600 hover:text-gray-900">Webhooks</a>
            </div>
          </div>
        </nav>
        <ActiveTests />
        {children}
      </body>
    </html>
  );
}
