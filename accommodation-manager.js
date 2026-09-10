(() => {
  const accommodation = window.tibetAccommodation;
  if (!accommodation) return;

  const $ = id => document.getElementById(id);
  const escape = window.TibetAMapUtils.escapeHtml;
  const kindLabel = type => type === 'area' ? '住宿区域' : '酒店 / 民宿';
  let editingId = null;

  function dayLabel(index) {
    const day = window.tripPlan?.days?.[index];
    return day ? `第 ${index + 1} 晚 · ${day.date} ${day.weekday}` : `第 ${index + 1} 晚`;
  }

  function usedNights(baseId) {
    return accommodation.overnightDays.filter(index => accommodation.getDayStay(index)?.id === baseId);
  }

  function status(message, isError = false) {
    const element = $('accommodation-manager-status');
    if (!element) return;
    element.textContent = message;
    element.dataset.state = isError ? 'error' : 'ok';
  }

  function baseMeta(base) {
    const parts = [kindLabel(base.type)];
    if (base.address) parts.push(base.address);
    return parts.map(escape).join(' · ');
  }

  function nightActions(nights) {
    return nights.map(index => `<li><span>${escape(dayLabel(index))}</span><button type="button" data-manager-restore="${index}">恢复默认住宿</button></li>`).join('');
  }

  function baseCard(base, nights, actions) {
    const notes = base.notes ? `<p class="accommodation-manager-notes">${escape(base.notes)}</p>` : '';
    const nightsBlock = nights.length
      ? `<div class="accommodation-manager-nights"><span>关联晚次</span><ul>${nightActions(nights)}</ul></div>`
      : '<p class="accommodation-manager-unused">尚未安排到任何晚次</p>';
    return `<article class="accommodation-manager-card" data-manager-base="${escape(base.id)}"><div class="accommodation-manager-card-main"><div class="accommodation-manager-card-heading"><h4>${escape(base.name)}</h4><span>${base.isDefault ? '默认住宿' : nights.length ? '正在使用' : '备选'}</span></div><p class="accommodation-manager-meta">${baseMeta(base)}</p><p class="accommodation-manager-coordinates">代表位置 ${Number(base.lat).toFixed(5)}, ${Number(base.lng).toFixed(5)}</p>${notes}${nightsBlock}</div>${actions ? `<div class="accommodation-manager-actions">${actions}</div>` : ''}</article>`;
  }

  function render() {
    const bases = accommodation.listBases();
    const customBases = bases.filter(base => !base.isDefault);
    const used = customBases.filter(base => usedNights(base.id).length);
    const backups = customBases.filter(base => !usedNights(base.id).length);
    const defaults = bases.filter(base => base.isDefault);
    const usedList = $('accommodation-manager-used-list');
    const backupList = $('accommodation-manager-backup-list');
    const defaultList = $('accommodation-manager-default-list');
    if (!usedList || !backupList || !defaultList) return;

    usedList.innerHTML = used.length
      ? used.map(base => baseCard(base, usedNights(base.id), `<button type="button" data-manager-edit="${escape(base.id)}">编辑</button><button type="button" data-manager-delete="${escape(base.id)}">删除</button><button type="button" data-manager-replace="${usedNights(base.id)[0]}">更换住宿</button>`)).join('')
      : '<p class="accommodation-manager-empty">还没有正在使用的自定义基地。</p>';
    backupList.innerHTML = backups.length
      ? backups.map(base => baseCard(base, [], `<button type="button" data-manager-edit="${escape(base.id)}">编辑</button><button type="button" data-manager-delete="${escape(base.id)}">删除</button>`)).join('')
      : '<p class="accommodation-manager-empty">暂无备选基地。</p>';
    defaultList.innerHTML = defaults.map(base => baseCard(base, usedNights(base.id), '<span class="accommodation-manager-immutable">默认住宿不可编辑或删除</span>')).join('');

    const nightList = $('accommodation-manager-night-list');
    if (nightList) {
      nightList.innerHTML = accommodation.overnightDays.map(index => {
        const stay = accommodation.getDayStay(index);
        return `<li><div><strong>${escape(dayLabel(index))}</strong><span>${escape(stay?.name || '未安排')}</span></div><button type="button" data-manager-restore="${index}">恢复默认住宿</button></li>`;
      }).join('');
    }
    if (editingId && !accommodation.getBase(editingId)) hideEditor();
    window.lucide?.createIcons();
  }

  function hideEditor() {
    editingId = null;
    $('accommodation-manager-editor')?.setAttribute('hidden', '');
  }

  function showEditor(id) {
    const base = accommodation.getBase(id);
    if (!base) return;
    if (base.isDefault) {
      status('默认住宿不可编辑。', true);
      return;
    }
    editingId = id;
    $('accommodation-manager-edit-name').value = base.name;
    $('accommodation-manager-edit-type').value = base.type;
    $('accommodation-manager-edit-address').value = base.address || '';
    $('accommodation-manager-edit-notes').value = base.notes || '';
    $('accommodation-manager-edit-lat').value = base.lat;
    $('accommodation-manager-edit-lng').value = base.lng;
    $('accommodation-manager-editor')?.removeAttribute('hidden');
    $('accommodation-manager-edit-name')?.focus();
    status(`正在编辑“${base.name}”。`);
  }

  function saveEditor() {
    if (!editingId) return;
    const result = accommodation.updateBase(editingId, {
      name: $('accommodation-manager-edit-name').value,
      type: $('accommodation-manager-edit-type').value,
      address: $('accommodation-manager-edit-address').value,
      notes: $('accommodation-manager-edit-notes').value,
      lat: $('accommodation-manager-edit-lat').value,
      lng: $('accommodation-manager-edit-lng').value
    });
    if (!result.ok) {
      status(result.error, true);
      return;
    }
    hideEditor();
    render();
    status('住宿基地已更新。');
  }

  function restore(index) {
    const result = accommodation.restoreDay(index);
    if (!result.ok) {
      status(result.error, true);
      return;
    }
    render();
    status(result.changed?.length ? `${dayLabel(index)}已恢复默认住宿。` : `${dayLabel(index)}已经是默认住宿。`);
  }

  function remove(id) {
    const base = accommodation.getBase(id);
    if (!base) return;
    const result = accommodation.deleteBase(id);
    if (!result.ok) {
      status(result.error, true);
      return;
    }
    render();
    status(`住宿基地“${base.name}”已删除。`);
  }

  function close() {
    hideEditor();
    const dialog = $('accommodation-manager-dialog');
    if (dialog?.open) dialog.close();
  }

  function open() {
    render();
    status('修改会同步到所有关联晚次。');
    const dialog = $('accommodation-manager-dialog');
    if (dialog?.showModal) dialog.showModal();
  }

  function build() {
    const nav = document.querySelector('.topbar nav');
    if (nav && !document.getElementById('manage-accommodation')) {
      nav.insertAdjacentHTML('afterbegin', '<button type="button" id="manage-accommodation" title="管理住宿基地"><i data-lucide="hotel"></i><span>住宿基地</span></button>');
    }
    document.body.insertAdjacentHTML('beforeend', `<dialog id="accommodation-manager-dialog" aria-labelledby="accommodation-manager-title"><div class="accommodation-manager-heading"><div><p class="eyebrow">ACCOMMODATION BASES</p><h2 id="accommodation-manager-title">住宿基地</h2></div><button type="button" id="accommodation-manager-close" title="关闭" aria-label="关闭"><i data-lucide="x"></i></button></div><p class="accommodation-manager-intro">管理正在使用的基地和备选基地。默认住宿始终保留，数据只保存在当前浏览器。</p><section class="accommodation-manager-section"><div class="accommodation-manager-section-heading"><h3>正在使用</h3><span>自定义基地</span></div><div id="accommodation-manager-used-list"></div></section><section class="accommodation-manager-section"><div class="accommodation-manager-section-heading"><h3>备选基地</h3><span>尚未用于任何晚次</span></div><div id="accommodation-manager-backup-list"></div></section><section class="accommodation-manager-section"><div class="accommodation-manager-section-heading"><h3>默认住宿</h3><span>不可编辑或删除</span></div><div id="accommodation-manager-default-list"></div></section><section class="accommodation-manager-section"><div class="accommodation-manager-section-heading"><h3>每晚住宿</h3><span>可恢复原有安排</span></div><ul id="accommodation-manager-night-list" class="accommodation-manager-night-list"></ul></section><section id="accommodation-manager-editor" class="accommodation-manager-editor" hidden><div class="accommodation-manager-section-heading"><h3>编辑住宿基地</h3><button type="button" id="accommodation-manager-cancel-edit">取消</button></div><form id="accommodation-manager-edit-form"><label>编辑基地名称<input id="accommodation-manager-edit-name" maxlength="120" required></label><label>编辑类型<select id="accommodation-manager-edit-type"><option value="hotel">酒店 / 民宿</option><option value="area">住宿区域</option></select></label><label>编辑详细地址（选填）<input id="accommodation-manager-edit-address" maxlength="240"></label><label>编辑备注（选填）<textarea id="accommodation-manager-edit-notes" maxlength="600" rows="3"></textarea></label><div class="accommodation-manager-coordinate-grid"><label>编辑纬度<input id="accommodation-manager-edit-lat" type="number" min="-90" max="90" step="any" required></label><label>编辑经度<input id="accommodation-manager-edit-lng" type="number" min="-180" max="180" step="any" required></label></div><div class="accommodation-manager-editor-actions"><button type="submit">保存修改</button><button type="button" id="accommodation-manager-cancel-edit-secondary">取消</button></div></form></section><p id="accommodation-manager-status" role="status" aria-live="polite"></p></dialog>`);

    $('manage-accommodation')?.addEventListener('click', open);
    $('accommodation-manager-close')?.addEventListener('click', close);
    $('accommodation-manager-cancel-edit')?.addEventListener('click', hideEditor);
    $('accommodation-manager-cancel-edit-secondary')?.addEventListener('click', hideEditor);
    $('accommodation-manager-edit-form')?.addEventListener('submit', event => {
      event.preventDefault();
      saveEditor();
    });
    $('accommodation-manager-dialog')?.addEventListener('click', event => {
      const edit = event.target.closest('[data-manager-edit]');
      if (edit) {
        showEditor(edit.dataset.managerEdit);
        return;
      }
      const removeButton = event.target.closest('[data-manager-delete]');
      if (removeButton) {
        const base = accommodation.getBase(removeButton.dataset.managerDelete);
        if (base && window.confirm(`删除住宿基地“${base.name}”？`)) remove(base.id);
        return;
      }
      const replace = event.target.closest('[data-manager-replace]');
      if (replace) {
        close();
        accommodation.open(Number(replace.dataset.managerReplace));
        return;
      }
      const restoreButton = event.target.closest('[data-manager-restore]');
      if (restoreButton) restore(Number(restoreButton.dataset.managerRestore));
    });
    accommodation.onChange(() => {
      if ($('accommodation-manager-dialog')?.open) render();
    });
    window.lucide?.createIcons();
  }

  window.tibetAccommodationManager = {open, close, render};
  build();
})();
