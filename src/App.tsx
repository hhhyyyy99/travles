import { useCallback, useRef, useState } from 'react'
import {
  AlertTriangle,
  ArrowUpRight,
  BedDouble,
  CalendarDays,
  CarFront,
  CloudSun,
  Coffee,
  KeyRound,
  PlaneLanding,
  PlaneTakeoff,
  Ticket,
  Wind,
} from 'lucide-react'
import { Checklist } from './components/Checklist'
import { DaysPanel } from './components/DaysPanel'
import { RoutePanel } from './components/RoutePanel'
import { useRouteMap } from './hooks/useRouteMap'
import type { RouteMapHandle } from './services/map'
import { dayPointCoords, tripPlan } from './data/itinerary'
import {
  allRouteGeometries,
  drawSelectedDay,
  fitTrip,
  focusDay,
  renderFullRoute,
  showTimeLabels,
  staticRouteGeometry,
} from './services/map'

const OVERVIEW_LEGEND = '全程参考连线 · 非道路导航'

/**
 * 呼伦贝尔，慢慢走 — React shell (tickets 01–08). Day selection lives here
 * (`selectedDay`), mirroring the legacy module state; `choose`/`fit` are the
 * imperative port of trip.js:167–193 (map drawing is not React state).
 */
export default function App() {
  const [selectedDay, setSelectedDay] = useState(0)
  const [overview, setOverview] = useState(true)
  const [legend, setLegend] = useState(OVERVIEW_LEGEND)

  const mapHandleRef = useRef<RouteMapHandle | null>(null)

  const choose = useCallback((day: number, focus = true) => {
    setSelectedDay(day)
    setOverview(false)
    const road = staticRouteGeometry(day)
    const coords = dayPointCoords(day)
    setLegend(road ? '行程连线示意 · 非道路导航' : '市区目的地 · 高德实时规划路线')
    const handle = mapHandleRef.current
    if (!handle) return
    drawSelectedDay(handle, road, coords)
    if (focus) focusDay(handle, road ?? coords)
    const estimate = tripPlan.estimates[day]
    showTimeLabels(
      handle,
      road && estimate ? [{ index: day, title: estimate.title, time: estimate.time, coordinates: road }] : [],
    )
  }, [])

  const fit = useCallback(() => {
    setOverview(true)
    setLegend(OVERVIEW_LEGEND)
    const handle = mapHandleRef.current
    if (!handle) return
    const geometries = allRouteGeometries()
    renderFullRoute(handle, geometries)
    fitTrip(handle, geometries.flat())
    showTimeLabels(handle, [])
  }, [])

  // Legacy boot order (trip.js:256): choose(0,false) then fit() → overview on,
  // day-0 detail rendered, no day focus, 全程 legend.
  const handleMapReady = useCallback(() => {
    choose(0, false)
    fit()
  }, [choose, fit])

  // Static markers click with focus=false (trip.js:138).
  const handleMarkerDaySelect = useCallback(
    (day: number) => {
      choose(day, false)
    },
    [choose],
  )

  const { containerRef, tileError } = useRouteMap({
    onDaySelect: handleMarkerDaySelect,
    onMapReady: handleMapReady,
    handleRef: mapHandleRef,
  })

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
        <section className="intro flex items-center justify-between gap-[30px] pt-[42px] pb-[30px] max-[1050px]:items-start max-[720px]:block max-[720px]:pt-[28px] max-[720px]:pb-[22px]">
          <div>
            <p className="eyebrow text-[11px] text-green font-[650] mb-[10px]">2026 / OCTOBER · 海拉尔进出</p>
            <h1 className="text-[42px] font-[600] leading-[1.3] max-[720px]:text-[34px]">呼伦贝尔，慢慢走。</h1>
            <p className="intro-copy text-muted mt-[13px] max-[720px]:text-[13px] max-[720px]:max-w-[320px]">
              海拉尔、莫尔格勒河、额尔古纳湿地、莫尔道嘎与满洲里。10 月 7 日回到海拉尔，8 日从容返程。
            </p>
          </div>
          <div className="flight flex gap-[30px] text-[12px] max-[1050px]:flex-col max-[1050px]:gap-[13px] max-[720px]:flex-row max-[720px]:justify-between max-[720px]:gap-[10px] max-[720px]:mt-[25px] max-[720px]:text-[13px]">
            <p className="flex items-center gap-[12px] max-[720px]:gap-[8px]">
              <PlaneLanding aria-hidden="true" className="text-green" />
              <span>
                10 月 02 日
                <strong className="block text-[15px] font-[550] mt-[3px] max-[720px]:text-[13px]">20:00 抵达海拉尔</strong>
              </span>
            </p>
            <p className="flex items-center gap-[12px] max-[720px]:gap-[8px]">
              <PlaneTakeoff aria-hidden="true" className="text-green" />
              <span>
                10 月 08 日
                <strong className="block text-[15px] font-[550] mt-[3px] max-[720px]:text-[13px]">16:00 海拉尔起飞</strong>
              </span>
            </p>
          </div>
        </section>
        <div className="summary flex items-center gap-[32px] border-y border-line py-[16px] mb-[28px] text-[13px] max-[1050px]:gap-[16px] max-[720px]:grid max-[720px]:grid-cols-2 max-[720px]:gap-[10px] max-[720px]:text-[11px] max-[720px]:py-[13px] max-[720px]:mb-[22px]">
          <span className="flex items-center gap-[7px]">
            <CalendarDays aria-hidden="true" className="w-[17px] text-muted" />
            <b>7 天 6 晚</b>
          </span>
          <span className="flex items-center gap-[7px]">
            <CarFront aria-hidden="true" className="w-[17px] text-muted" />
            <b id="distance-summary">约 1,000–1,100 km</b>
          </span>
          <span className="flex items-center gap-[7px]">
            <BedDouble aria-hidden="true" className="w-[17px] text-muted" />
            <b id="accommodation-count">5</b> 处住宿基地
          </span>
          <span className="pace flex items-center gap-[7px] text-green ml-auto max-[720px]:m-0 max-[720px]:text-[10px]">
            <Coffee aria-hidden="true" className="w-[17px] text-muted max-[720px]:hidden" />
            景观优先 · 逆时针慢环线
          </span>
        </div>
        <section className="journey grid grid-cols-[280px_minmax(0,1fr)] gap-[30px] items-start max-[1050px]:grid-cols-[235px_minmax(0,1fr)] max-[1050px]:gap-[22px] max-[720px]:flex max-[720px]:flex-col max-[720px]:items-stretch max-[720px]:gap-[18px]" id="journey">
          <DaysPanel selectedDay={selectedDay} onSelectDay={choose} />
          <RoutePanel
            containerRef={containerRef}
            selectedDay={selectedDay}
            overview={overview}
            legend={legend}
            tileError={tileError}
            onFit={fit}
            onSelectDay={choose}
          />
        </section>
        <section className="reason border-t border-line mt-[42px] pt-[30px] max-[720px]:mt-[28px] max-[720px]:pt-[24px]">
          <div className="section-label flex items-center justify-between mb-[22px] gap-[12px]">
            <h2 className="text-[20px] max-[720px]:text-[18px]">少一点赶路，多一点余地</h2>
            <span className="text-[10px] text-muted max-[720px]:text-[9px]">OUR APPROACH</span>
          </div>
          <div className="reason-grid grid grid-cols-3 gap-[36px] max-[720px]:grid-cols-1 max-[720px]:gap-[20px]">
            <div className="max-[720px]:relative max-[720px]:pl-[32px]">
              <span className="number text-[11px] text-green max-[720px]:absolute max-[720px]:left-0 max-[720px]:top-[6px]">01</span>
              <h3 className="text-[17px] mt-[5px] mb-[8px] max-[720px]:text-[16px] max-[720px]:mt-0">先落地，再出发</h3>
              <p className="text-[13px] text-muted leading-[1.9]">
                10/2 落地海拉尔只休息，10/3 才正式出发。把森林段放在 3–5 号，把满洲里与呼伦湖放最后，10/7 提前一晚回海拉尔闭环。
              </p>
            </div>
            <div className="max-[720px]:relative max-[720px]:pl-[32px]">
              <span className="number text-[11px] text-green max-[720px]:absolute max-[720px]:left-0 max-[720px]:top-[6px]">02</span>
              <h3 className="text-[17px] mt-[5px] mb-[8px] max-[720px]:text-[16px] max-[720px]:mt-0">每天只抓一个重点</h3>
              <p className="text-[13px] text-muted leading-[1.9]">
                10/3 草原加湿地，10/4 只留给莫尔道嘎，10/6 满洲里只选一个收费景区加夜景。10/5 是最长一天，其余天基本 3–4 小时。
              </p>
            </div>
            <div className="max-[720px]:relative max-[720px]:pl-[32px]">
              <span className="number text-[11px] text-green max-[720px]:absolute max-[720px]:left-0 max-[720px]:top-[6px]">03</span>
              <h3 className="text-[17px] mt-[5px] mb-[8px] max-[720px]:text-[16px] max-[720px]:mt-0">把卡线留给下次</h3>
              <p className="text-[13px] text-muted leading-[1.9]">
                纳入莫尔道嘎、室韦、黑山头、186彩带河与满洲里；根河、敖鲁古雅、白桦林、恩和、乌兰山、五卡七卡九卡留给下次。
              </p>
            </div>
          </div>
        </section>
        <section id="prepare" className="prepare border-t border-line mt-[42px] pt-[30px] max-[720px]:mt-[28px] max-[720px]:pt-[24px]">
          <div className="section-label flex items-center justify-between mb-[22px] gap-[12px]">
            <h2 className="text-[20px] max-[720px]:text-[18px]">出发前，安排好这几件事</h2>
            <span className="text-[10px] text-muted max-[720px]:text-[9px]">TRAVEL NOTES</span>
          </div>
          <div className="notes-grid grid grid-cols-2 gap-x-[40px] max-[720px]:grid-cols-1">
            <details open>
              <summary>
                <KeyRound aria-hidden="true" />
                租车与住哪里
              </summary>
              <div>
                <p>
                  <b>海拉尔东山机场同点取还，无异地还车费。</b>
                  核对保险免赔、轮胎玻璃保障、里程限制和门店营业时间。10/8 提前问清满油还车与航站楼距离。
                </p>
                <p>
                  住海拉尔、额尔古纳、莫尔道嘎、黑山头、满洲里共 6 晚。莫尔道嘎、黑山头优先订有独立暖气、热水稳定的实体酒店或木刻楞民宿，订房直接问「晚上有没有供暖」，不建议住蒙古包。
                </p>
                <p>
                  普通铺装公路以车况可靠的轿车或 SUV 为主，默认走 G331、G332 等主路。白天开车，每 1.5–2 小时休息，加油勿等到见底。
                </p>
              </div>
            </details>
            <details open>
              <summary>
                <Ticket aria-hidden="true" />
                国庆预约与预算
              </summary>
              <div>
                <p>
                  国庆假期 10/1–7 完整覆盖。莫尔道嘎、黑山头、满洲里的车与住宿现在就订，尽量选可取消。额尔古纳湿地、莫尔道嘎的门票与开放时间临行再核实。
                </p>
                <p>
                  <b>粗略预算：两人合计 ¥8,000–12,000，不含往返机票。</b>
                  这是国庆预留额度，非实时价格：住宿 ¥2,400–4,000；租车与保险 ¥2,000–3,000；油费、停车及市内交通 ¥1,000–1,500；餐饮 ¥1,400–2,000；门票等 ¥500–1,000，另留机动金。
                </p>
              </div>
            </details>
            <details open>
              <summary>
                <CloudSun aria-hidden="true" />
                天气与保暖
              </summary>
              <div>
                <p>
                  10 月初不是夏天的绿草原，看到的主要是金黄草原、湿地、落叶松和白桦林的秋末色调。9 月下旬到 10 月 5 日左右是这一带金秋窗口，所以森林段排前面、满洲里与呼伦湖放后面。
                </p>
                <p>莫尔道嘎、黑山头一带晚上已经冷，风也大。分层穿衣：保暖内层、抓绒或薄羽绒、外层防风衣，带帽子、手套和保温杯；具体天气出发前 3–7 天查询。</p>
              </div>
            </details>
            <details open>
              <summary>
                <AlertTriangle aria-hidden="true" />
                天气与路况怎么改
              </summary>
              <div>
                <p>10 月初卡线可能下雪、结冰或管制，以当天导航与当地确认为准。默认走 G331、G332 等主路，状态好再临时走一段景观路线。</p>
                <p>
                  10/5 疲劳或路况差，就减掉室韦之后的一段景观路直接去黑山头；10/7 必须回到海拉尔，返程缓冲不能拿来补景点。草原林区天黑后动物、结霜、无灯公路与信号都会变差，尽量不夜驾。
                </p>
              </div>
            </details>
          </div>
        </section>
        <Checklist />
        <section className="sources my-[35px] text-[11px] text-muted border-t border-line pt-[22px]">
          <h2 className="text-[13px] font-[550] mb-[8px]">行程依据与边界</h2>
          <p>
            资料核实于 2026 年 9 月 8 日。默认中国大陆居民、持有效驾照及身份证。里程、驾驶时长和海拔均为规划估算，非实时导航；不含国庆拥堵、景区排队及长时间用餐。每日另留机动时间，出发前查交通公告、天气与门店实际位置。
          </p>
          <div className="flex flex-wrap gap-x-[20px] gap-y-[8px] mt-[12px]">
            <a className="border-b border-[#a9b8ae]" href="https://travel.sina.cn/2026-07-05/detail-iniftrzc2188110.d.html?vt=4" target="_blank" rel="noopener">
              新浪旅游 · 呼伦贝尔自驾路线
            </a>
            <a className="border-b border-[#a9b8ae]" href="https://you.ctrip.com/sight/ergun2026/140919.html" target="_blank" rel="noopener">
              携程 · 额尔古纳湿地
            </a>
            <a className="border-b border-[#a9b8ae]" href="https://you.ctrip.com/sight/ergun2026/70703.html" target="_blank" rel="noopener">
              携程 · 莫尔道嘎国家森林公园
            </a>
            <a className="border-b border-[#a9b8ae]" href="https://eegn.gov.cn/OpennessContent/show/554351.html" target="_blank" rel="noopener">
              额尔古纳市政府 · 道路养护
            </a>
            <a
              className="border-b border-[#a9b8ae]"
              href="https://big5.www.gov.cn/gate/big5/www.gov.cn/gongbao/2025/issue_12406/202511/content_7048922.html"
              target="_blank"
              rel="noopener"
            >
              中国政府网 · 2026 节假日安排
            </a>
            <a className="border-b border-[#a9b8ae]" href="https://www.sina.cn/gc/article/ninttrp7368310.html" target="_blank" rel="noopener">
              新浪 · 呼伦贝尔秋季路线
            </a>
          </div>
        </section>
      </main>
      <footer className="footer border-t border-line py-[22px] px-[4%] flex items-center justify-between gap-[15px] text-[10px] text-muted max-[720px]:flex-col">
        <span>草原之间 / 呼伦贝尔, AT YOUR OWN PACE.</span>
        <a className="flex items-center gap-[5px]" href="#journey">
          返回行程地图
          <ArrowUpRight aria-hidden="true" />
        </a>
      </footer>
    </>
  )
}