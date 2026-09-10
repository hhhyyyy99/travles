(function(root) {
  const statuses = ['畅通', '缓行', '拥堵', '严重拥堵', '未知'];
  const colors = {'畅通':'#259b57','缓行':'#dfaa23','拥堵':'#e44b45','严重拥堵':'#a41d32','未知':'#8b949b'};
  function duration(seconds) {
    if (seconds == null || seconds === '' || !Number.isFinite(Number(seconds)) || Number(seconds) < 0) return '暂无时间';
    const minutes = Math.max(1, Math.ceil(Number(seconds) / 60));
    return minutes < 60 ? `${minutes} 分钟` : `${Math.floor(minutes / 60)} 小时${minutes % 60 ? ` ${minutes % 60} 分钟` : ''}`;
  }
  function traffic(route) {
    const totals = Object.fromEntries(statuses.map(s => [s, 0]));
    const segments = [];
    for (const step of route.steps || []) {
      if (!step.tmcs?.length) continue;
      for (const segment of step.tmcs) {
        const status = statuses.includes(segment.status) ? segment.status : '未知';
        const distance = Math.max(0, Number(segment.distance) || 0);
        totals[status] += distance;
        segments.push({...segment, status});
      }
    }
    const accounted = Object.values(totals).reduce((a,b) => a+b, 0);
    totals['未知'] += Math.max(0, (Number(route.distance)||0) - accounted);
    return {totals, segments, known:statuses.slice(0,4).some(s => totals[s] > 0)};
  }
  const api = {statuses, colors, duration, traffic};
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TibetAMapUtils = api;
})(typeof window === 'object' ? window : globalThis);
