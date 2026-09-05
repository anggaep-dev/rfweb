import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import Button from './Button';
import './Dialog.css';

export interface DialogAction {
  label: string;
  onClick: () => void;
  variant?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
  loading?: boolean;
}

export interface DialogProps {
  /** Whether the dialog is visible */
  open: boolean;
  /** Window header title (design.md §5.1) */
  title: string;
  /** Body content */
  children?: ReactNode;
  /** Action buttons in the footer — default: single "Close" secondary */
  actions?: DialogAction[];
  /** Close handler (called on backdrop click, Escape, or close button) */
  onClose: () => void;
  /** When true, clicking the backdrop closes the dialog — default: true */
  closeOnBackdrop?: boolean;
  /** When true, pressing Escape closes the dialog — default: true */
  closeOnEscape?: boolean;
}

/**
 * Aether Mech HUD Dialog / Modal
 *
 * A HUD-styled modal window with:
 * - Dark backdrop overlay
 * - Window frame header with status LED and close button (§5.1)
 * - Scrollable content area
 * - Action footer with themed buttons
 * - Keyboard (Escape) and backdrop dismiss
 */
export default function Dialog({
  open,
  title,
  children,
  actions,
  onClose,
  closeOnBackdrop = true,
  closeOnEscape = true,
}: DialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  // Focus trap: auto-focus the dialog on open
  useEffect(() => {
    if (open) {
      // Small delay so the dialog is in the DOM before focus
      const id = requestAnimationFrame(() => {
        dialogRef.current?.focus();
      });
      return () => cancelAnimationFrame(id);
    }
  }, [open]);

  // Escape key handler
  useEffect(() => {
    if (!open || !closeOnEscape) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open, closeOnEscape, onClose]);

  if (!open) return null;

  const defaultActions: DialogAction[] = actions ?? [{ label: 'Close', onClick: onClose, variant: 'secondary' }];

  return createPortal(
    <div
      className="dialog-backdrop"
      onClick={closeOnBackdrop ? onClose : undefined}
      role="presentation"
    >
      <div
        className="dialog"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header — design.md §5.1 */}
        <div className="dialog-header">
          <div className="dialog-header-left">
            <span className="dialog-led" />
            <span className="dialog-title">{title}</span>
          </div>
          <button className="dialog-close" onClick={onClose} aria-label="Close dialog" type="button">
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="dialog-body">{children}</div>

        {/* Footer actions */}
        {defaultActions.length > 0 && (
          <div className="dialog-footer">
            {defaultActions.map((action, i) => (
              <Button
                key={i}
                variant={action.variant ?? 'secondary'}
                size="sm"
                onClick={action.onClick}
                disabled={action.disabled}
                loading={action.loading}
              >
                {action.label}
              </Button>
            ))}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}