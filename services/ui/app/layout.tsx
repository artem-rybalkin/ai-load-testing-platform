import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Sidebar from "@/app/components/Sidebar";
import BottomNav from "@/app/components/BottomNav";
import TopBar from "@/app/components/TopBar";
import ActiveTests from "@/app/components/ActiveTests";
import SystemHealth from "@/app/components/SystemHealth";
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
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body suppressHydrationWarning className="bg-[#f6f7f8] text-[#24292f]">
        <div className="flex min-h-screen">
          <Sidebar />
          <div className="flex-1 min-w-0 flex flex-col">
            <TopBar />
            <ActiveTests />
            <SystemHealth />
            <main className="flex-1 pb-14 lg:pb-0">
              {children}
            </main>
          </div>
        </div>
        <BottomNav />
      </body>
    </html>
  );
}
