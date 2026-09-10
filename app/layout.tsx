import type { Metadata, Viewport } from 'next';
import 'leaflet/dist/leaflet.css';
import './globals.css';

export const metadata: Metadata = {
  title: '西藏，慢慢走 · 10.02—10.08 自驾手册',
  description: '林芝、索松村、结巴村与羊湖。10 月 7 日抵达拉萨，8 日从容返程。',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#f8faf9',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
