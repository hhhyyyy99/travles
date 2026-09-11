/**
 * ConfirmDialog (ticket 10) — the destructive-action confirmation used for
 * day deletion. The message spells out that the day's cards are removed
 * with it (ticket requirement: 删天有确认，含卡一并删除).
 */
export default function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = '确认删除',
  cancelLabel = '取消',
  onConfirm,
  onCancel,
}: {
  open: boolean
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  onConfirm: () => void
  onCancel: () => void
}) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/30">
      <div
        data-confirm-dialog
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-[380px] rounded-[8px] border border-line bg-white p-[20px] shadow-lg"
      >
        <h2 className="text-[15px] font-[600] text-ink">{title}</h2>
        <p className="mt-[8px] text-[13px] leading-[1.6] text-muted">{message}</p>
        <div className="mt-[16px] flex justify-end gap-[8px]">
          <button
            type="button"
            data-action="cancel-delete"
            onClick={onCancel}
            className="h-[30px] rounded-[5px] border border-line px-[14px] text-[13px] text-muted hover:border-green hover:text-green transition-colors"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            data-action="confirm-delete"
            onClick={onConfirm}
            className="h-[30px] rounded-[5px] bg-[#b75342] px-[14px] text-[13px] text-white"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
