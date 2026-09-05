import { type ButtonHTMLAttributes, type ReactNode } from 'react';
import './Button.css';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** Visual variant — default: 'primary' (gold CTA) */
  variant?: ButtonVariant;
  /** Size preset — default: 'md' */
  size?: ButtonSize;
  /** Shows a loading spinner and disables the button */
  loading?: boolean;
  /** Icon slot (renders before label text) */
  icon?: ReactNode;
  children?: ReactNode;
}

const variantClass: Record<ButtonVariant, string> = {
  primary: 'btn-primary',
  secondary: 'btn-secondary',
  ghost: 'btn-ghost',
  danger: 'btn-danger',
};

const sizeClass: Record<ButtonSize, string> = {
  sm: 'btn-sm',
  md: 'btn-md',
  lg: 'btn-lg',
};

/**
 * Aether Mech HUD Button
 *
 * - **Primary**: Gold gradient CTA with glow (design.md §5.4)
 * - **Secondary**: Chrome-bordered tactical action
 * - **Ghost**: Minimal, no border — for inline/dialog close uses
 * - **Danger**: Vital-ruby accent for destructive actions
 */
export default function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  icon,
  className = '',
  disabled,
  children,
  ...rest
}: ButtonProps) {
  const classes = [
    'btn',
    variantClass[variant],
    sizeClass[size],
    loading ? 'btn-loading' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button className={classes} disabled={disabled || loading} {...rest}>
      {loading ? (
        <span className="btn-spinner" aria-hidden="true" />
      ) : icon ? (
        <span className="btn-icon">{icon}</span>
      ) : null}
      {children && <span className="btn-label">{children}</span>}
    </button>
  );
}