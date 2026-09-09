import React from 'react';
import { ArrowUpRight } from 'lucide-react';

export default function Footer() {
  return (
    <footer className="footer">
      <span>山湖之间 / TIBET, AT YOUR OWN PACE.</span>
      <a href="#journey">
        返回行程地图 <ArrowUpRight />
      </a>
    </footer>
  );
}
