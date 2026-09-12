/**
 * Built-in example trip seed data (ticket 03).
 *
 * A compact port of the static guide content (`src/data/itinerary.ts` +
 * `src/data/roadRoutes.ts`) into the server package. The server cannot import
 * the frontend `src/` tree (separate workspace package, separate tsconfig
 * rootDir), so the seed carries its own copy; the guide page keeps reading
 * `src/data/*` and stays byte-faithful. If the guide content ever changes,
 * this file is the place to port it (the seed only runs once per database —
 * the app_meta marker — so edits here do not touch already-seeded installs).
 *
 * Content is copied verbatim from the guide; only layout differs:
 * - day dates get an explicit year (the guide stores MM.DD only) so the trip
 *   row has a real YYYY-MM-DD range. SEED_YEAR pins it; the guide's 10.02–10.08
 *   window is the National-Day holiday referenced across the content.
 * - the drive/duration numbers come from `roadRoutes.legs` (index-locked to
 *   days via `legByDay`), converted to km / minutes.
 *
 * ID scheme (fixed, coordinated by convention — tickets 04/08 must not reuse
 * these prefixes for their own rows):
 * - trip:      `builtin-hailar-oct7`
 * - days:      `builtin-day-<dayIndex>`            (0..6)
 * - items:     `builtin-item-<dayIndex>-<order>`   (overview + schedule rows)
 * - stay item: `builtin-stay-day-<dayIndex>`       (one per overnight day;
 *              the ticket-03 localStorage migration UPSERTS these same ids)
 * - legs:      `builtin-leg-day-<dayIndex>` (additional waypoint segments use
 *              `builtin-leg-day-<dayIndex>-<segmentIndex>`)
 * - seed marker: app_meta key `builtin-trip.hailar-oct7`
 */

export const BUILTIN_TRIP_ID = 'builtin-hailar-oct7'
export const BUILTIN_TRIP_TITLE = '呼伦贝尔慢环线 · 示例行程'
export const BUILTIN_TRIP_SEED_MARKER = 'builtin-trip.hailar-oct7'

/** Guide dates are MM.DD only; the seed pins this year onto the range. */
export const BUILTIN_TRIP_SEED_YEAR = 2026

export type BuiltinTripPoint = {
  amapId: string
  name: string
  lat: number
  lng: number
  category: string
  rating: number
  introSummary: string
}

/** Stable WGS-84 point catalog mirrored from src/data/itinerary.ts. */
export const BUILTIN_TRIP_POINTS = {
  airportH: {
    amapId: 'airportH',
    name: '海拉尔东山机场',
    lat: 49.205,
    lng: 119.826,
    category: '交通',
    rating: 0,
    introSummary: '海拉尔东山机场，行程起终点。',
  },
  hailar: {
    amapId: 'hailar',
    name: '海拉尔 · 2 晚',
    lat: 49.212,
    lng: 119.766,
    category: '城市',
    rating: 0,
    introSummary: '海拉尔市区，取车与返程住宿点。',
  },
  morigele: {
    amapId: 'morigele',
    name: '莫尔格勒河',
    lat: 49.35,
    lng: 119.62,
    category: '景点',
    rating: 0,
    introSummary: '草原腹地的曲水景观。',
  },
  erguna: {
    amapId: 'erguna',
    name: '额尔古纳 · 1 晚',
    lat: 50.243,
    lng: 120.183,
    category: '城市',
    rating: 0,
    introSummary: '额尔古纳城区，湿地行程落脚点。',
  },
  mordaoga: {
    amapId: 'mordaoga',
    name: '莫尔道嘎 · 1 晚',
    lat: 51.26,
    lng: 120.78,
    category: '城市',
    rating: 0,
    introSummary: '莫尔道嘎镇与国家森林公园入口。',
  },
  shiwei: {
    amapId: 'shiwei',
    name: '室韦口岸',
    lat: 51.34,
    lng: 119.9,
    category: '景点',
    rating: 0,
    introSummary: '中俄界河边的室韦口岸。',
  },
  heishantou: {
    amapId: 'heishantou',
    name: '黑山头 · 1 晚',
    lat: 50.12,
    lng: 119.28,
    category: '城市',
    rating: 0,
    introSummary: '黑山头镇，边境草原落脚点。',
  },
  caidaihe: {
    amapId: 'caidaihe',
    name: '186彩带河',
    lat: 49.88,
    lng: 118.98,
    category: '景点',
    rating: 0,
    introSummary: '俯瞰额尔古纳河与湿地的观景点。',
  },
  manzhouli: {
    amapId: 'manzhouli',
    name: '满洲里 · 1 晚',
    lat: 49.597,
    lng: 117.452,
    category: '城市',
    rating: 0,
    introSummary: '满洲里市区，夜景与餐饮落脚点。',
  },
  hulunlake: {
    amapId: 'hulunlake',
    name: '呼伦湖',
    lat: 48.97,
    lng: 117.58,
    category: '景点',
    rating: 0,
    introSummary: '呼伦湖湖畔停留点。',
  },
} as const satisfies Record<string, BuiltinTripPoint>

export type BuiltinTripPointKey = keyof typeof BUILTIN_TRIP_POINTS

/** Day point order mirrors each guide day's `points` array. */
export const BUILTIN_TRIP_DAY_POINT_KEYS = [
  ['airportH', 'hailar'],
  ['hailar', 'morigele', 'erguna'],
  ['erguna', 'mordaoga'],
  ['mordaoga', 'shiwei', 'heishantou'],
  ['heishantou', 'caidaihe', 'manzhouli'],
  ['manzhouli', 'hulunlake', 'hailar'],
  ['hailar', 'airportH'],
] as const satisfies readonly (readonly BuiltinTripPointKey[])[]

export type SeedScheduleRow = readonly [time: string, title: string, detail: string]

export interface SeedDay {
  /** MM.DD as written in the guide. */
  date: string
  /** Guide `day.title`. */
  theme: string
  /** Guide `day.short` — the "A → B" route summary. */
  short: string
  /** Guide `day.drive` — human distance/time estimate. */
  drive: string
  /** Guide `day.stay`; null on the return day without a night. */
  stay: string | null
  /** Guide `day.alt`. */
  alt: string
  /** Guide `day.pace`. */
  pace: string
  desc: string
  tip: string
  schedule: readonly SeedScheduleRow[]
  /** Aggregate reference route from roadRoutes.legs[legByDay[dayIndex]]. */
  leg: { distanceKm: number; durationMin: number; coordinates: readonly (readonly [number, number])[] }
}

export const BUILTIN_TRIP_DAYS: readonly SeedDay[] = [
  {
    date: '10.02',
    theme: '初到海拉尔，落地只休息',
    short: '机场 → 海拉尔',
    drive: '约 10–15 km / 很短',
    stay: '海拉尔 · 第 1 晚',
    alt: '约 610 m',
    pace: '落地休息',
    desc: '20:00 落地后取车、吃饭、入住，不赶路。第一天不追草原，不直接赶去额尔古纳。',
    tip: '航班延误就直接入住。国庆期间先确认租车门店营业时间与还车流程。',
    schedule: [
      ['20:00', '抵达海拉尔东山机场', '预留 1–1.5 小时取行李、验车和办理租车。'],
      ['21:00', '取车后去市区', '约 15 分钟驾驶，吃晚饭后入住休息。'],
      ['22:30', '早点休息', '不安排市区景点，为明天养足精神。'],
    ],
    leg: { distanceKm: 6, durationMin: 15, coordinates: [[119.826, 49.205], [119.766, 49.212]]  },
  },
  {
    date: '10.03',
    theme: '莫尔格勒河，再看额尔古纳湿地',
    short: '海拉尔 → 额尔古纳',
    drive: '约 150 km / 2.5–3 小时',
    stay: '额尔古纳 · 1 晚',
    alt: '约 580–650 m',
    pace: '草原与湿地',
    desc: '上午草原看曲水，下午额尔古纳湿地景区，一天就两个核心点。',
    tip: '只选额尔古纳湿地景区，不再重复去额尔古纳国家湿地公园；两者不是同一个景区。',
    schedule: [
      ['09:00', '海拉尔出发', '走正常导航道路，先去看莫尔格勒河。'],
      ['10:30', '莫尔格勒河短暂停留', '看曲水、草原和沿途风景，约 1 小时左右离开。'],
      ['14:00', '抵达额尔古纳湿地景区', '玩 2 小时左右，傍晚入住额尔古纳城区。'],
    ],
    leg: { distanceKm: 150, durationMin: 165, coordinates: [[119.766, 49.212], [119.62, 49.35], [120.183, 50.243]]  },
  },
  {
    date: '10.04',
    theme: '把时间留给莫尔道嘎',
    short: '额尔古纳 → 莫尔道嘎',
    drive: '约 220 km / 4 小时',
    stay: '莫尔道嘎 · 1 晚',
    alt: '约 700 m（林区）',
    pace: '转场日',
    desc: '上午转场，下午重点玩莫尔道嘎国家森林公园，不再塞别的景点。',
    tip: '景区营业约 08:30–17:30，国庆后逐渐季节性调整，所以放在行程前半段而不是最后。',
    schedule: [
      ['08:30', '额尔古纳出发', '中午前后抵达莫尔道嘎，午餐后进森林公园。'],
      ['13:00', '莫尔道嘎国家森林公园', '玩核心区 2.5–3.5 小时，不深挖白鹿岛、奇乾。'],
      ['18:00', '入住莫尔道嘎镇', '早点休息。'],
    ],
    leg: { distanceKm: 220, durationMin: 240, coordinates: [[120.183, 50.243], [120.78, 51.26]]  },
  },
  {
    date: '10.05',
    theme: '室韦界河边走走，再去黑山头',
    short: '莫尔道嘎 → 黑山头',
    drive: '约 250 km / 4.5–5 小时',
    stay: '黑山头 · 1 晚',
    alt: '约 500–700 m',
    pace: '全程最长',
    desc: '最长一天：室韦吃午饭、界河边走走，下午沿边境去黑山头，看日落随缘。',
    tip: '别硬追九卡、七卡、五卡、乌兰山；骑马也不是必选项，10 月初风大又冷。',
    schedule: [
      ['09:00', '莫尔道嘎出发', '约七八十公里到室韦，上午不用早起。'],
      ['10:30', '室韦停留', '看中俄界河、村子，午饭，控制在 1–1.5 小时。'],
      ['13:00', '沿 G331 方向去黑山头', '默认走主路；卡线状态好再临时走一段景观路线。'],
      ['16:30', '到黑山头', '天气好看日落，不好直接回酒店。'],
    ],
    leg: { distanceKm: 250, durationMin: 285, coordinates: [[120.78, 51.26], [119.9, 51.34], [119.28, 50.12]]  },
  },
  {
    date: '10.06',
    theme: '186彩带河后，进满洲里',
    short: '黑山头 → 满洲里',
    drive: '约 210–230 km / 3–3.5 小时',
    stay: '满洲里 · 1 晚',
    alt: '约 640 m',
    pace: '轻松模式',
    desc: '上午 186彩带河看额尔古纳河与湿地，下午进满洲里，选一个收费景区加晚上夜景。',
    tip: '10 月滑草等项目有没有开都别在意，这里的价值是景色不是项目。',
    schedule: [
      ['09:30', '黑山头出发', '186彩带河很近，山顶看河与湿地约 1 小时。'],
      ['12:00', '往满洲里', '路上简餐，下午到酒店后休息一下。'],
      ['15:30', '满洲里市区', '国门与夜景二选一，不做旅游团式全打卡。'],
      ['19:00', '俄餐或涮羊肉', '晚上才是满洲里比较有感觉的时候。'],
    ],
    leg: { distanceKm: 220, durationMin: 195, coordinates: [[119.28, 50.12], [118.98, 49.88], [117.452, 49.597]]  },
  },
  {
    date: '10.07',
    theme: '看呼伦湖，回到海拉尔',
    short: '满洲里 → 海拉尔',
    drive: '约 230–250 km / 3–3.5 小时',
    stay: '海拉尔 · 第 2 晚',
    alt: '约 610 m',
    pace: '返程闭环',
    desc: '睡到自然醒，呼伦湖停 1–1.5 小时，下午回海拉尔，17:00 左右到酒店。',
    tip: '这一天千万不要再住满洲里，否则第二天飞机会有长途自驾风险。',
    schedule: [
      ['09:30', '满洲里出发', '去呼伦湖。'],
      ['11:00', '呼伦湖停留', '湖边 1 个多小时足够，风大半小时即可走。'],
      ['14:00', '回海拉尔', '下午直接回，不中途再排景点。'],
      ['17:00', '到海拉尔酒店', '晚上好好吃顿饭，行程提前一晚闭环。'],
    ],
    leg: { distanceKm: 240, durationMin: 195, coordinates: [[117.452, 49.597], [117.58, 48.97], [119.766, 49.212]]  },
  },
  {
    date: '10.08',
    theme: '从容去机场，16:00 回家',
    short: '海拉尔 → 机场',
    drive: '约 10–15 km / 很短',
    stay: null,
    alt: '机场约 610 m',
    pace: '返程缓冲',
    desc: '睡到自然醒，吃蒙餐/锅茶，市区买点东西，14:00 前进入航站楼，16:00 起飞。',
    tip: '上午不要再跑 100 公里外的景点、中午往机场冲；返程缓冲不能拿来补景点。',
    schedule: [
      ['09:30', '自然醒，早餐', '吃顿蒙餐或锅茶，有兴趣买牛肉干、奶制品。'],
      ['12:30', '开始收尾', '先加满油，再还车。'],
      ['14:00', '进入机场', '预留值机、托运、安检时间，截止以航空公司为准。'],
      ['16:00', '航班起飞', '结束七天六晚的自驾旅行。'],
    ],
    leg: { distanceKm: 6, durationMin: 15, coordinates: [[119.766, 49.212], [119.826, 49.205]]  },
  },
]

/**
 * Item classification for guide schedule rows (PRD §6 types). Deterministic
 * keyword mapping; anything unmatched is an attraction card.
 */
export function classifyScheduleItem(title: string): 'traffic' | 'food' | 'attraction' {
  if (/餐|涮/.test(title)) return 'food'
  if (/出发|抵达|入住|取车|还车|进入机场|起飞|前往|往|到|回/.test(title)) return 'traffic'
  return 'attraction'
}

/** `2026-10-02` style date from the guide's MM.DD + the seed year. */
export function seedDate(dateMMDD: string): string {
  const [month, day] = dateMMDD.split('.')
  return `${BUILTIN_TRIP_SEED_YEAR}-${month}-${day}`
}
