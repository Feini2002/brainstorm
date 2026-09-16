/**
 * Shared presentational primitives (docs/02_architecture/03_ui_information_design.md §1).
 *
 * These are pure UI: no data fetching, no database, no session handling. Feature
 * components compose them so there is exactly one Button, one EmptyState and one
 * error treatment across the six pages.
 */
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  Ref,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';

/* -------------------------------------------------------------------------- */
/* Button                                                                     */
/* -------------------------------------------------------------------------- */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-[var(--ink)] text-[var(--surface)] hover:opacity-90 disabled:opacity-50',
  secondary:
    'border border-[var(--line)] bg-[var(--surface)] text-[var(--ink)] hover:bg-[var(--surface-raised)] disabled:opacity-50',
  ghost:
    'text-[var(--ink-muted)] hover:bg-[var(--surface-raised)] hover:text-[var(--ink)] disabled:opacity-50',
  danger:
    'border border-[var(--danger)] text-[var(--danger)] hover:bg-[var(--danger)] hover:text-[var(--surface)] disabled:opacity-50',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  ref?: Ref<HTMLButtonElement>;
}

export function Button({ variant = 'secondary', className = '', ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      className={`inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed ${BUTTON_VARIANTS[variant]} ${className}`}
    />
  );
}

/* -------------------------------------------------------------------------- */
/* Inputs                                                                     */
/* -------------------------------------------------------------------------- */

const FIELD_BASE =
  'w-full rounded-md border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--ink)] placeholder:text-[var(--ink-muted)] disabled:opacity-60';

/**
 * Input primitives accept `ref` as a normal prop (React 19 forwards it) so a
 * feature can focus a field without each caller wrapping the element itself.
 */
export type TextInputProps = InputHTMLAttributes<HTMLInputElement> & {
  ref?: Ref<HTMLInputElement>;
};

export function TextInput({ className = '', ...rest }: TextInputProps) {
  return <input {...rest} className={`${FIELD_BASE} ${className}`} />;
}

export type TextAreaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  ref?: Ref<HTMLTextAreaElement>;
};

export function TextArea({ className = '', ...rest }: TextAreaProps) {
  return <textarea {...rest} className={`${FIELD_BASE} ${className}`} />;
}

export type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & {
  ref?: Ref<HTMLSelectElement>;
};

export function Select({ className = '', ...rest }: SelectProps) {
  return <select {...rest} className={`${FIELD_BASE} ${className}`} />;
}

export interface FieldProps {
  label: string;
  htmlFor: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}

/**
 * Labelled field. The error text is linked with aria-describedby so a screen
 * reader announces it with the input (docs/…/03_ui_information_design.md §7).
 */
export function Field({ label, htmlFor, hint, error, children }: FieldProps) {
  const describedBy = error ? `${htmlFor}-error` : hint ? `${htmlFor}-hint` : undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-sm font-medium text-[var(--ink)]">
        {label}
      </label>
      <div aria-describedby={describedBy}>{children}</div>
      {hint ? (
        <p id={`${htmlFor}-hint`} className="text-xs text-[var(--ink-muted)]">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${htmlFor}-error`} role="alert" className="text-xs text-[var(--danger)]">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* States                                                                     */
/* -------------------------------------------------------------------------- */

export interface EmptyStateProps {
  title: string;
  /** Concrete next action, never a generic "something went wrong". */
  description: string;
  action?: ReactNode;
}

export function EmptyState({ title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-lg border border-dashed border-[var(--line)] bg-[var(--surface-raised)] p-6">
      <h2 className="text-base font-semibold text-[var(--ink)]">{title}</h2>
      <p className="max-w-prose text-sm text-[var(--ink-muted)]">{description}</p>
      {action}
    </div>
  );
}

export function InlineError({ message, children }: { message: string; children?: ReactNode }) {
  return (
    <div
      role="alert"
      className="flex flex-col gap-2 rounded-md border border-[var(--danger)] bg-[var(--surface)] p-3 text-sm text-[var(--danger)]"
    >
      <span>{message}</span>
      {children}
    </div>
  );
}

/**
 * The one loader atom.
 *
 * `label` is required and must name the action being waited on (T082-R03). It
 * used to default to 「加载中」, which meant every caller that forgot the prop
 * announced the same thing whether it was refetching the graph, searching the
 * library or reading a backup file — indistinguishable to a screen-reader user,
 * and useless for telling "the app is thinking" from "the app is stuck". A new
 * call site now has to say which of those it is.
 *
 * The ellipsis is added here rather than by each caller so the punctuation cannot
 * drift between 「正在搜索…」 and 「正在搜索...」.
 */
export function LoadingIndicator({ label }: { label: string }) {
  return (
    <span role="status" aria-live="polite" className="text-sm text-[var(--ink-muted)]">
      {label}…
    </span>
  );
}

export function SectionCard({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-[var(--line)] bg-[var(--surface)] p-4">
      <header className="flex flex-col gap-1">
        <h2 className="text-sm font-semibold text-[var(--ink)]">{title}</h2>
        {description ? <p className="text-xs text-[var(--ink-muted)]">{description}</p> : null}
      </header>
      {children}
    </section>
  );
}
