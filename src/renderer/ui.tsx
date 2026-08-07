import React from 'react';
import type { StatusTone } from '../shared/bridge';
import { AlertIcon, CheckCircleIcon, InfoIcon, XCircleIcon, XIcon } from './icons';

// ---------------------------------------------------------------- primitives

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'ghost' | 'danger';
  size?: 'md' | 'sm';
  icon?: boolean;
  block?: boolean;
};

export function Button({
  variant = 'default',
  size = 'md',
  icon = false,
  block = false,
  className = '',
  type = 'button',
  ...rest
}: ButtonProps) {
  const classes = [
    'btn',
    variant !== 'default' ? `btn--${variant}` : '',
    size === 'sm' ? 'btn--sm' : '',
    icon ? 'btn--icon' : '',
    block ? 'btn--block' : '',
    className
  ]
    .filter(Boolean)
    .join(' ');

  return <button type={type} className={classes} {...rest} />;
}

export function Field({
  label,
  hint,
  error,
  children
}: {
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      {children}
      {error ? <span className="field__error">{error}</span> : hint ? <span className="field__hint">{hint}</span> : null}
    </label>
  );
}

export function Badge({
  tone = 'neutral',
  children
}: {
  tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger';
  children: React.ReactNode;
}) {
  return <span className={`badge badge--${tone}`}>{children}</span>;
}

export function Switch({
  checked,
  onChange,
  label,
  disabled
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  /** Greyed out and inert — for a setting that only matters under some other condition. */
  disabled?: boolean;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={checked ? 'switch is-on' : 'switch'}
      onClick={() => onChange(!checked)}
    />
  );
}

export function SwitchRow({
  title,
  description,
  checked,
  onChange,
  disabled
}: {
  title: string;
  description: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className={disabled ? 'switch-row is-disabled' : 'switch-row'}>
      <div className="switch-row__body">
        <div className="switch-row__title">{title}</div>
        <div className="switch-row__desc">{description}</div>
      </div>
      <Switch checked={checked} onChange={onChange} label={title} disabled={disabled} />
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  text,
  actions
}: {
  icon: React.ReactNode;
  title: string;
  text: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty__icon">{icon}</div>
      <div className="empty__title">{title}</div>
      <p className="empty__text">{text}</p>
      {actions ? <div className="empty__actions">{actions}</div> : null}
    </div>
  );
}

export function Callout({
  tone = 'warning',
  icon,
  title,
  text,
  action
}: {
  tone?: 'warning' | 'accent';
  icon: React.ReactNode;
  title: string;
  text?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className={`callout callout--${tone}`}>
      <span className="callout__icon">{icon}</span>
      <div className="callout__body">
        <div className="callout__title">{title}</div>
        {text ? <div className="callout__text">{text}</div> : null}
      </div>
      {action}
    </div>
  );
}

/** Guards actions that cannot be undone: closing a room, removing a member. */
export function ConfirmModal({
  title,
  description,
  confirmLabel,
  onConfirm,
  onClose
}: {
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="danger"
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="text-secondary">{description}</p>
    </Modal>
  );
}

// --------------------------------------------------------------------- modal

export function Modal({
  title,
  description,
  onClose,
  children,
  footer
}: {
  title: string;
  description?: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const surfaceRef = React.useRef<HTMLDivElement>(null);
  // Callers write onClose as a fresh arrow function every render, so depending
  // on it directly would re-run the effects below every time anything on the
  // page underneath changed. Pinning it to a ref keeps them mount-only.
  const closeRef = React.useRef(onClose);
  closeRef.current = onClose;

  React.useEffect(() => {
    // Escape closes — and claims the key first, in the capture phase, so
    // nothing else listening on `document` (the welcome tour's own Escape
    // handler, chiefly) also reacts to the same press. Without this, opening
    // a dialog while the tour happens to still be up meant one Escape both
    // closed the dialog *and* silently finished the tour.
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        closeRef.current();
      }
    }

    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, []);

  React.useEffect(() => {
    /*
     * Focus moves into the dialog on open so keyboard users are not left behind
     * on the page underneath. Strictly on open: repeating it would drag the
     * caret out of whatever field is being filled in and back to the first one,
     * mid-word, every time a peer or a clipboard update re-rendered the app.
     */
    const surface = surfaceRef.current;
    // Prefer the first field; fall back to a button for dialogs with no input.
    const target =
      surface?.querySelector<HTMLElement>('.modal__body input, .modal__body select') ??
      surface?.querySelector<HTMLElement>('.modal__footer button');
    target?.focus();
  }, []);

  return (
    <div className="overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} ref={surfaceRef}>
        <div className="modal__header">
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 className="modal__title">{title}</h2>
            {description ? <p className="modal__desc">{description}</p> : null}
          </div>
          <Button variant="ghost" size="sm" icon onClick={onClose} aria-label="Close">
            <XIcon size={15} />
          </Button>
        </div>
        <div className="modal__body">{children}</div>
        {footer ? <div className="modal__footer">{footer}</div> : null}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- toasts

type Toast = { id: number; message: string; tone: StatusTone };

const TOAST_MS = 4200;

/**
 * A small stack of self-dismissing status messages. Shared by every window
 * that shows toasts — the main window, and now the call and remote windows —
 * so each does not carry its own copy of the same timer bookkeeping.
 */
export function useToasts() {
  const [toasts, setToasts] = React.useState<Toast[]>([]);
  const nextId = React.useRef(0);

  const push = React.useCallback((message: string, tone: StatusTone = 'info') => {
    const id = nextId.current++;

    setToasts((current) => {
      // The same message twice over is one event as far as anyone reading it
      // is concerned. It moves back to the bottom and its timer restarts
      // rather than filling the corner with copies of itself.
      const withoutDuplicate = current.filter((toast) => toast.message !== message);
      return [...withoutDuplicate, { id, message, tone }].slice(-4);
    });

    setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), TOAST_MS);
  }, []);

  const dismiss = React.useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  return { toasts, push, dismiss };
}

function ToastIcon({ tone }: { tone: StatusTone }) {
  if (tone === 'success') return <CheckCircleIcon size={16} />;
  if (tone === 'warning') return <AlertIcon size={16} />;
  if (tone === 'error') return <XCircleIcon size={16} />;
  return <InfoIcon size={16} />;
}

export function Toasts({
  toasts,
  onDismiss
}: {
  toasts: Toast[];
  onDismiss: (id: number) => void;
}) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast--${toast.tone}`} onClick={() => onDismiss(toast.id)}>
          <span className="toast__icon">
            <ToastIcon tone={toast.tone} />
          </span>
          <span className="toast__message">{toast.message}</span>
        </div>
      ))}
    </div>
  );
}
