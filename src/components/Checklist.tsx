import { useEffect, useState } from 'react'
import {
  CHECKLIST_DEFAULT_STATUS,
  CHECKLIST_DENOMINATOR,
  CHECKLIST_ITEMS,
  CHECKLIST_SAVE_FAILURE_STATUS,
  loadChecklist,
  normalizeChecklist,
  saveChecklist,
} from '../domain/checklist'

/**
 * 我的出发清单 — faithful port of trip.js:247–251 + index.html:25.
 * Count denominator hardcoded 6; writes on every change AND on mount
 * (persists the cleaned selection, mirroring the legacy boot updateChecks).
 * On save failure the exact status string is shown and in-page state is kept.
 */
export function Checklist() {
  const [checked, setChecked] = useState<ReadonlySet<number>>(() => {
    // Normalize at load so out-of-range indices never act as checked boxes,
    // matching the legacy `saved.includes(i)` semantics.
    return new Set(normalizeChecklist(loadChecklist(window.localStorage)))
  })
  const [status, setStatus] = useState(CHECKLIST_DEFAULT_STATUS)

  useEffect(() => {
    const ok = saveChecklist(window.localStorage, checked)
    setStatus(ok ? CHECKLIST_DEFAULT_STATUS : CHECKLIST_SAVE_FAILURE_STATUS)
  }, [checked])

  const toggle = (index: number) => {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  return (
    <section className="check-section border-t border-line mt-[42px] pt-[30px] max-sm:mt-[28px] max-sm:pt-[24px]">
      <div className="section-label flex items-center justify-between mb-[22px] gap-[12px]">
        <h2 className="text-[20px] max-sm:text-[18px]">我的出发清单</h2>
        <span id="check-count" className="text-[10px] text-muted max-sm:text-[9px]">
          {checked.size} / {CHECKLIST_DENOMINATOR}
        </span>
      </div>
      <div id="checklist" className="checklist grid grid-cols-3 gap-[14px] max-sm:grid-cols-2 max-sm:gap-[14px_8px]">
        {CHECKLIST_ITEMS.map((label, index) => (
          <label
            key={index}
            className={`flex items-center gap-[10px] text-[13px] cursor-pointer max-sm:text-[12px] ${
              checked.has(index) ? 'text-muted line-through' : ''
            }`}
          >
            <input
              type="checkbox"
              value={index}
              checked={checked.has(index)}
              onChange={() => toggle(index)}
              className="accent-green w-[17px] h-[17px]"
            />
            {label}
          </label>
        ))}
      </div>
      <p id="save-status" className="fine text-[11px] text-muted mt-[15px]">
        {status}
      </p>
    </section>
  )
}
