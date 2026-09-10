import { Wind } from 'lucide-react'
import { Checklist } from './components/Checklist'

/**
 * Minimal page shell for tickets 01–08: legacy topbar brand copy +
 * the checklist section. Other sections (intro, summary, journey, reason,
 * prepare, sources, footer, print) land in later tickets.
 */
export default function App() {
  return (
    <>
      <header className="topbar flex h-[76px] items-center justify-between border-b border-line px-[4%] bg-paper max-sm:h-[62px] max-sm:px-[5%] max-sm:gap-[10px]">
        <a
          href="#"
          className="brand flex items-center gap-[10px] text-[18px] font-[650] max-sm:min-w-0 max-sm:flex-1 max-sm:whitespace-nowrap max-sm:overflow-hidden max-sm:text-ellipsis max-sm:text-[16px]"
        >
          <Wind aria-hidden="true" className="text-green w-[28px] h-[28px]" />
          草原之间
          <span className="text-[10px] font-[450] text-muted ml-[14px] max-sm:hidden">旅行手册 / 呼伦贝尔</span>
        </a>
        <nav className="flex items-center gap-[30px] text-[13px] max-sm:gap-[8px] max-sm:text-[12px] max-sm:flex-none">
          <a href="#journey" className="max-sm:hidden">每日行程</a>
          <a href="#prepare" className="max-sm:hidden">出发准备</a>
        </nav>
      </header>
      <main className="mx-auto max-w-[1440px] px-[4%] max-sm:px-[5%]">
        <Checklist />
      </main>
    </>
  )
}
