import React from 'react';
import { XIcon } from './icons';

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
  label
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={checked ? 'switch is-on' : 'switch'}
      onClick={() => onChange(!checked)}
    />
  );
}

export function SwitchRow({
  title,
  description,
  checked,
  onChange
}: {
  title: string;
  description: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="switch-row">
      <div className="switch-row__body">
        <div className="switch-row__title">{title}</div>
        <div className="switch-row__desc">{description}</div>
      </div>
      <Switch checked={checked} onChange={onChange} label={title} />
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

  React.useEffect(() => {
    // Escape closes, and focus moves into the dialog so keyboard users are not
    // left behind on the page underneath.
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose();
      }
    }

    document.addEventListener('keydown', onKeyDown);

    // Prefer the first field; fall back to a button for dialogs with no input.
    const surface = surfaceRef.current;
    const target =
      surface?.querySelector<HTMLElement>('.modal__body input, .modal__body select') ??
      surface?.querySelector<HTMLElement>('.modal__footer button');
    target?.focus();

    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

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
