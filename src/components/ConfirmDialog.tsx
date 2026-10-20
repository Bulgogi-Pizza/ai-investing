import { useEffect, useId, useRef, type ReactNode } from 'react';

/**
 * Modal confirmation. Focus moves to the cancel button (the safe choice), Tab stays inside, Escape
 * and the backdrop cancel, and focus returns to the element that opened it.
 */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  cancelLabel = '취소',
  tone = 'default',
  busy = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: 'default' | 'danger';
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    return () => opener?.focus?.();
  }, []);
  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onCancel();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled])');
    if (!items || items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <section
        ref={dialogRef}
        className={`modal confirm-dialog confirm-${tone}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <h2 id={titleId}>{title}</h2>
        <div id={descriptionId} className="confirm-body">
          {children}
        </div>
        <div className="confirm-actions">
          <button ref={cancelRef} className="button" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
          <button
            className={`button primary${tone === 'danger' ? ' danger' : ''}`}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? '처리 중…' : confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}
