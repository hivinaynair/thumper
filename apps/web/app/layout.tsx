import type { Metadata } from "next";
import {
  ClerkProvider,
  Show,
  SignInButton,
  UserButton,
} from "@clerk/nextjs";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const sans = Geist({ subsets: ["latin"], variable: "--font-sans" });
const mono = Geist_Mono({ subsets: ["latin"], variable: "--font-mono" });

export const metadata: Metadata = {
  title: "Thumper",
  description: "Private high-quality audio harvest for the booth",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <ClerkProvider>
      <html lang="en">
        <body className={`${sans.variable} ${mono.variable}`}>
          <header className="topbar">
            <Link href="/" className="brand">
              Thumper
            </Link>
            <nav>
              <Show when="signed-in">
                <Link href="/downloader">Downloader</Link>
                <UserButton />
              </Show>
              <Show when="signed-out">
                <SignInButton mode="modal" />
              </Show>
            </nav>
          </header>
          <main>{children}</main>
        </body>
      </html>
    </ClerkProvider>
  );
}
