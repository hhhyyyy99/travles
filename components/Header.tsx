'use client';

import React from 'react';
import { MountainSnow, Printer } from 'lucide-react';

export default function Header() {
  const handlePrint = () => {
    window.print();
  };

  return (
    <header className="topbar">
      <a className="brand" href="#">
        <MountainSnow />
        山湖之间 <span>旅行手册 / TIBET</span>
      </a>
      <nav>
        <a href="#journey">每日行程</a>
        <a href="#prepare">出发准备</a>
        <button
          id="print"
          onClick={handlePrint}
          title="打印或存为 PDF"
          aria-label="打印或存为 PDF"
        >
          <Printer />
        </button>
      </nav>
    </header>
  );
}
