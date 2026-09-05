import { useCallback, useEffect, useRef, useState, type HTMLAttributes, type ReactNode, type MouseEvent as ReactMouseEvent, type TouchEvent as ReactTouchEvent } from 'react';
import Button from './Button';
import './Card.css';

export type CardVariant = 'default' | 'elevated' | 'recessed';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** Visual elevation level — default: 'default' (panel) */
  variant?: CardVariant;
  /** Optional header title (renders a HUD window frame per design.md §5.1) */
  title?: string;
  /** Show a glowing status LED next to the title */
  statusLed?: boolean;
  /** Optional close action (renders close button in header) */
  onClose?: () => void;
  /** Header action slot (rendered right side, before close) */
  headerActions?: ReactNode;
  /** Confirm button label — when set, renders a confirm button at bottom-right */
  confirmLabel?: string;
  /** Confirm button handler */
  onConfirm?: () => void;
  /** Confirm button loading state */
  confirmLoading?: boolean;
  /** Confirm button disabled state */
  confirmDisabled?: boolean;
  /** When true, the card can be dragged by its header */
  draggable?: boolean;
  /** Initial position for draggable cards */
  defaultPosition?: { x: number; y: number };
  children?: ReactNode;
}

const variantClass: Record<CardVariant, string> = {
  default: 'card-panel',
  elevated: 'card-elevated',
  recessed: 'card-recessed',
};

/**
 * Aether Mech HUD Card / Panel
 *
 * Three elevation levels matching the design system:
 * - **default**: Level 1 window substrate — primary container
 * - **elevated**: Level 2 active element with gold glow
 * - **recessed**: Level 0 recessed slot — for equipment/inventory grids
 *
 * When `title` is provided, renders a HUD window frame header
 * (design.md §5.1) with an optional status LED and close button.
 *
 * When `draggable` is true, the header acts as a drag handle to
 * reposition the card freely on the screen.
 */
export default function Card({
  variant = 'default',
  title,
  statusLed = false,
  onClose,
  headerActions,
  confirmLabel,
  onConfirm,
  confirmLoading = false,
  confirmDisabled = false,
  draggable = false,
  defaultPosition,
  className = '',
  style,
  children,
  ...rest
}: CardProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const dragState = useRef<{ startX: number; startY: number; offsetX: number; offsetY: number } | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(defaultPosition ?? null);
  const [isDragging, setIsDragging] = useState(false);

  // ── Drag handlers ──
  const handleDragStart = useCallback((clientX: number, clientY: number) => {
    const el = cardRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    dragState.current = {
      startX: clientX,
      startY: clientY,
      offsetX: clientX - rect.left,
      offsetY: clientY - rect.top,
    };
    setIsDragging(true);
  }, []);

  const handleDragMove = useCallback((clientX: number, clientY: number) => {
    const ds = dragState.current;
    if (!ds) return;
    setPos({
      x: clientX - ds.offsetX,
      y: clientY - ds.offsetY,
    });
  }, []);

  const handleDragEnd = useCallback(() => {
    dragState.current = null;
    setIsDragging(false);
  }, []);

  // Mouse events on header
  const onHeaderMouseDown = useCallback(
    (e: ReactMouseEvent) => {
      if (!draggable) return;
      // Only drag from header, not from interactive children (buttons etc)
      if ((e.target as HTMLElement).closest('button, input, select, textarea, [role="button"]')) return;
      e.preventDefault();
      handleDragStart(e.clientX, e.clientY);
    },
    [draggable, handleDragStart],
  );

  // Touch events on header
  const onHeaderTouchStart = useCallback(
    (e: ReactTouchEvent) => {
      if (!draggable) return;
      if ((e.target as HTMLElement).closest('button, input, select, textarea, [role="button"]')) return;
      const touch = e.touches[0];
      if (!touch) return;
      handleDragStart(touch.clientX, touch.clientY);
    },
    [draggable, handleDragStart],
  );

  // Global move/up listeners while dragging
  useEffect(() => {
    if (!isDragging) return;
    const onMove = (e: MouseEvent | TouchEvent) => {
      const clientX = 'touches' in e ? e.touches[0]?.clientX ?? 0 : e.clientX;
      const clientY = 'touches' in e ? e.touches[0]?.clientY ?? 0 : e.clientY;
      handleDragMove(clientX, clientY);
    };
    const onUp = () => handleDragEnd();
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('touchmove', onMove, { passive: true });
    window.addEventListener('touchend', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onUp);
    };
  }, [isDragging, handleDragMove, handleDragEnd]);

  const classes = ['card', variantClass[variant], draggable ? 'card-draggable' : '', className]
    .filter(Boolean)
    .join(' ');

  const resolvedStyle: React.CSSProperties = {
    ...(pos ? { left: pos.x, top: pos.y } : {}),
    ...style,
  };

  return (
    <div className={classes} ref={cardRef} style={resolvedStyle} {...rest}>
      {title && (
        <div
          className="card-header"
          onMouseDown={onHeaderMouseDown}
          onTouchStart={onHeaderTouchStart}
        >
          <div className="card-header-left">
            {statusLed && <span className="card-led" />}
            <span className="card-title">{title}</span>
          </div>
          <div className="card-header-right">
            {headerActions}
            {onClose && (
              <button
                className="card-close"
                onClick={onClose}
                aria-label="Close panel"
                type="button"
              >
                ✕
              </button>
            )}
          </div>
        </div>
      )}
      <div className="card-body">{children}</div>
      {confirmLabel && onConfirm && (
        <div className="card-footer">
          <Button
            variant="primary"
            size="sm"
            onClick={onConfirm}
            loading={confirmLoading}
            disabled={confirmDisabled}
          >
            {confirmLabel}
          </Button>
        </div>
      )}
    </div>
  );
}