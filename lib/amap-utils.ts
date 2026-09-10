export type TrafficStatus = '畅通' | '缓行' | '拥堵' | '严重拥堵' | '未知';

export const trafficStatuses: TrafficStatus[] = ['畅通', '缓行', '拥堵', '严重拥堵', '未知'];

export const trafficColors: Record<TrafficStatus, string> = {
  '畅通': '#259b57',
  '缓行': '#dfaa23',
  '拥堵': '#e44b45',
  '严重拥堵': '#a41d32',
  '未知': '#8b949b',
};

export function duration(seconds?: number | string | null): string {
  if (
    seconds == null ||
    seconds === '' ||
    !Number.isFinite(Number(seconds)) ||
    Number(seconds) < 0
  ) {
    return '暂无时间';
  }
  const minutes = Math.max(1, Math.ceil(Number(seconds) / 60));
  return minutes < 60
    ? `${minutes} 分钟`
    : `${Math.floor(minutes / 60)} 小时${minutes % 60 ? ` ${minutes % 60} 分钟` : ''}`;
}

export interface TMCItem {
  status: string;
  distance: number | string;
  path?: [number, number][];
}

export interface RouteStep {
  road?: string;
  instruction?: string;
  path?: [number, number][];
  tmcs?: TMCItem[];
}

export interface TrafficRoute {
  distance?: number | string;
  time?: number | string;
  steps?: RouteStep[];
}

export interface TrafficResult {
  totals: Record<TrafficStatus, number>;
  segments: (TMCItem & { status: TrafficStatus })[];
  known: boolean;
}

export function traffic(route: TrafficRoute): TrafficResult {
  const totals: Record<TrafficStatus, number> = {
    '畅通': 0,
    '缓行': 0,
    '拥堵': 0,
    '严重拥堵': 0,
    '未知': 0,
  };
  const segments: (TMCItem & { status: TrafficStatus })[] = [];

  for (const step of route.steps || []) {
    if (!step.tmcs?.length) continue;
    for (const segment of step.tmcs) {
      const status: TrafficStatus = trafficStatuses.includes(segment.status as TrafficStatus)
        ? (segment.status as TrafficStatus)
        : '未知';
      const distance = Math.max(0, Number(segment.distance) || 0);
      totals[status] += distance;
      segments.push({ ...segment, status });
    }
  }

  const accounted = Object.values(totals).reduce((a, b) => a + b, 0);
  totals['未知'] += Math.max(0, (Number(route.distance) || 0) - accounted);

  return {
    totals,
    segments,
    known: trafficStatuses.slice(0, 4).some((s) => totals[s] > 0),
  };
}

const TibetAMapUtils = {
  statuses: trafficStatuses,
  colors: trafficColors,
  duration,
  traffic,
};

export default TibetAMapUtils;
