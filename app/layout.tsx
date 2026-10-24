import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Liniya — your AI support agent",
  description: "Add your company information and test your AI support agent in text and voice.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
