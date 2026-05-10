import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { SidebarShell } from "@/components/SidebarShell";
import { ThemeProvider } from "@/components/ThemeProvider";
import { QuotaBanner } from "@/components/QuotaBanner";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Open Brain",
  description: "Second brain dashboard",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="min-h-screen flex bg-bg-primary text-text-primary">
        <ThemeProvider>
          <QuotaBanner />
          <SidebarShell />
          <main className="flex-1 min-h-screen pt-12 md:pt-0 md:ml-[var(--sidebar-width,240px)] [transition:margin-left_160ms_ease]">
            <div className="legacy-wrapper">{children}</div>
          </main>
        </ThemeProvider>
      </body>
    </html>
  );
}
