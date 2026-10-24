import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Линия — ваш ИИ-оператор поддержки",
  description: "Создайте базу знаний и проверьте ответы вашего будущего телефонного ИИ-оператора.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ru"><body>{children}</body></html>;
}
