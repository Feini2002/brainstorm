import type { Metadata } from "next";
import "./globals.css";
import { AppShell } from "@/components/AppShell";

export const metadata: Metadata = {
  title: "Feini Brain",
  description: "本地单用户知识碎片工具：先可靠保存，再整理与投影。",
  robots: { index: false, follow: false },
};

/**
 * Root layout.
 *
 * No `next/font/google`: the app promises that page text and controls come from
 * the local build, with no CDN or remote font request (T024-R01/T024-C06). The
 * font stack in `globals.css` is entirely local (system UI fonts plus a Chinese
 * fallback), so the UI still renders with the network blocked.
 */
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN" className="h-full">
      <body className="min-h-full antialiased">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
