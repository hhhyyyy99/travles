(() => {
  const accommodation = window.tibetAccommodation;
  if (!accommodation) return;

  const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[character]));
  const $ = id => document.getElementById(id);
  let pending = null;

  function setStatus(message, tone = 'normal') {
    const status = $('accommodation-backup-status');
    if (!status) return;
    status.textContent = message;
    status.dataset.tone = tone;
  }

  function openDialog() {
    const dialog = $('accommodation-backup-dialog');
    if (dialog?.showModal && !dialog.open) dialog.showModal();
    else dialog?.removeAttribute('hidden');
  }

  function closeDialog() {
    const dialog = $('accommodation-backup-dialog');
    if (dialog?.open) dialog.close();
    else dialog?.setAttribute('hidden', '');
    pending = null;
    $('accommodation-backup-file').value = '';
    $('accommodation-backup-preview').setAttribute('hidden', '');
    $('accommodation-backup-confirm').disabled = true;
  }

  function formatFilename() {
    const date = new Date().toISOString().slice(0, 10).replaceAll('-', '');
    return `hailar-accommodation-v1-${date}.json`;
  }

  function downloadBackup() {
    const blob = new Blob([JSON.stringify(accommodation.getBackup(), null, 2)], {type: 'application/json'});
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = formatFilename();
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    setStatus('备份文件已导出。');
  }

  function importedBaseMap(value) {
    const bases = new Map(accommodation.listBases().map(base => [base.id, base]));
    value.bases.forEach(base => bases.set(base.id, base));
    return bases;
  }

  function renderPreview(value) {
    const bases = importedBaseMap(value);
    const nights = Object.keys(value.stays).sort((left, right) => Number(left) - Number(right)).map(day => {
      const base = bases.get(value.stays[day]);
      return `<li><span>第 ${Number(day) + 1} 晚</span><strong>${escape(base?.name || value.stays[day])}</strong></li>`;
    }).join('');
    const preview = $('accommodation-backup-preview');
    preview.innerHTML = `<p>文件格式 v${value.version}，包含 <strong>${value.bases.length}</strong> 个自定义住宿基地和 <strong>${Object.keys(value.stays).length}</strong> 晚住宿安排。</p><ul>${nights}</ul><p class="accommodation-backup-warning">确认后将整体替换当前住宿安排，不会与现有数据自动合并。</p>`;
    preview.removeAttribute('hidden');
    $('accommodation-backup-confirm').disabled = false;
  }

  async function handleImport(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    pending = null;
    $('accommodation-backup-preview').setAttribute('hidden', '');
    $('accommodation-backup-confirm').disabled = true;
    openDialog();
    try {
      const validation = accommodation.validateBackup(await file.text());
      if (!validation.ok) {
        setStatus(`无法导入：${validation.error}`, 'error');
        return;
      }
      pending = validation.value;
      renderPreview(pending);
      setStatus('请检查预览，并确认是否替换当前安排。');
    } catch {
      setStatus('无法读取备份文件，当前安排未改变。', 'error');
    }
  }

  function confirmImport() {
    if (!pending) return;
    const result = accommodation.replaceState(pending);
    if (!result.ok) {
      setStatus(`恢复失败：${result.error || '当前安排未改变。'}`, 'error');
      return;
    }
    closeDialog();
    setStatus('住宿备份已恢复。');
  }

  function buildUi() {
    const nav = document.querySelector('.topbar nav');
    if (nav && !document.getElementById('accommodation-backup-open')) {
      nav.insertAdjacentHTML('afterbegin', '<button type="button" id="accommodation-backup-open" title="导出或恢复住宿备份" aria-label="导出或恢复住宿备份"><i data-lucide="archive-restore"></i></button>');
    }
    document.body.insertAdjacentHTML('beforeend', `<dialog id="accommodation-backup-dialog" aria-labelledby="accommodation-backup-title"><form id="accommodation-backup-form"><div class="dialog-heading"><h2 id="accommodation-backup-title">住宿备份</h2><button type="button" id="accommodation-backup-close" title="关闭" aria-label="关闭"><i data-lucide="x"></i></button></div><p class="accommodation-backup-intro">备份仅包含自定义住宿基地和每晚住宿选择，不包含地图 Key 或其他应用设置。</p><div class="accommodation-backup-actions"><button type="button" id="accommodation-backup-export"><i data-lucide="download"></i>导出当前备份</button><label class="accommodation-backup-import"><i data-lucide="upload"></i>选择备份文件<input id="accommodation-backup-file" type="file" accept="application/json,.json"></label></div><section id="accommodation-backup-preview" class="accommodation-backup-preview" hidden></section><p id="accommodation-backup-status" role="status" aria-live="polite"></p><div class="dialog-actions accommodation-backup-confirm-actions"><button type="button" id="accommodation-backup-cancel">取消</button><button type="button" id="accommodation-backup-confirm" disabled>确认整体替换</button></div></form></dialog>`);
    $('accommodation-backup-open')?.addEventListener('click', () => {
      setStatus('可导出当前安排，或选择备份文件进行预览。');
      openDialog();
    });
    $('accommodation-backup-close').onclick = closeDialog;
    $('accommodation-backup-cancel').onclick = closeDialog;
    $('accommodation-backup-export').onclick = downloadBackup;
    $('accommodation-backup-file').addEventListener('change', handleImport);
    $('accommodation-backup-confirm').onclick = confirmImport;
    $('accommodation-backup-form').addEventListener('submit', event => event.preventDefault());
    $('accommodation-backup-dialog').addEventListener('cancel', event => { event.preventDefault(); closeDialog(); });
    window.lucide?.createIcons();
  }

  buildUi();
})();
