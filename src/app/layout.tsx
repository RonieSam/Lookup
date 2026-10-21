import type { Metadata, Viewport } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Neo ID lookup",
  description: "Paste Neo IDs, check each one, and see the matching student records.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  colorScheme: "light dark",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="site-header">
          <div className="wrap bar">
            <Link href="/" className="brand">
              Neo ID lookup
            </Link>
            <nav aria-label="Main">
              <Link href="/">Lookup</Link>
              <Link href="/admin">Admin</Link>
            </nav>
          </div>
        </header>
        <main className="wrap">{children}</main>
      </body>
    </html>
  );
}
