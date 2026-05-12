"use client";

import {
  forwardRef,
  InputHTMLAttributes,
  TextareaHTMLAttributes,
  SelectHTMLAttributes,
  LabelHTMLAttributes,
} from "react";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string;
}

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  error?: string;
  options: { value: string; label: string }[];
}

interface CheckboxProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
}

const baseInputClasses =
  "w-full rounded-lg border bg-transparent px-4 py-3 text-sm font-medium text-[var(--text)] placeholder:text-[var(--muted)] transition focus:outline-none focus:ring-2 focus:ring-[var(--cyan)] focus:border-[var(--cyan)] disabled:opacity-50 disabled:cursor-not-allowed";
const errorClasses = "border-[var(--error)] focus:ring-[var(--error)] focus:border-[var(--error)]";

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, className = "", id, ...props }, ref) => {
    const inputId = id || props.name;
    return (
      <div className="w-full">
        {label && (
          <Label htmlFor={inputId} required={props.required}>
            {label}
          </Label>
        )}
        <input
          ref={ref}
          id={inputId}
          className={`${baseInputClasses} ${error ? errorClasses : "border-white/15 focus:border-[var(--cyan)]"} ${className}`}
          aria-invalid={!!error}
          aria-describedby={error ? `${inputId}-error` : undefined}
          {...props}
        />
        {error && (
          <p
            id={`${inputId}-error`}
            className="mt-1.5 text-xs font-bold text-[var(--error)]"
            role="alert"
          >
            {error}
          </p>
        )}
      </div>
    );
  },
);
Input.displayName = "Input";

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ label, error, className = "", id, ...props }, ref) => {
    const inputId = id || props.name;
    return (
      <div className="w-full">
        {label && (
          <Label htmlFor={inputId} required={props.required}>
            {label}
          </Label>
        )}
        <textarea
          ref={ref}
          id={inputId}
          className={`${baseInputClasses} min-h-[120px] resize-y ${error ? errorClasses : "border-white/15 focus:border-[var(--cyan)]"} ${className}`}
          aria-invalid={!!error}
          aria-describedby={error ? `${inputId}-error` : undefined}
          {...props}
        />
        {error && (
          <p
            id={`${inputId}-error`}
            className="mt-1.5 text-xs font-bold text-[var(--error)]"
            role="alert"
          >
            {error}
          </p>
        )}
      </div>
    );
  },
);
Textarea.displayName = "Textarea";

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ label, error, options, className = "", id, ...props }, ref) => {
    const inputId = id || props.name;
    return (
      <div className="w-full">
        {label && (
          <Label htmlFor={inputId} required={props.required}>
            {label}
          </Label>
        )}
        <select
          ref={ref}
          id={inputId}
          className={`${baseInputClasses} appearance-none bg-no-repeat ${error ? errorClasses : "border-white/15 focus:border-[var(--cyan)]"} ${className}`}
          style={{
            backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%238c98a7' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E")`,
            backgroundPosition: "right 12px center",
          }}
          aria-invalid={!!error}
          aria-describedby={error ? `${inputId}-error` : undefined}
          {...props}
        >
          {options.map((option) => (
            <option
              key={option.value}
              value={option.value}
              className="bg-[var(--panel)] text-[var(--text)]"
            >
              {option.label}
            </option>
          ))}
        </select>
        {error && (
          <p
            id={`${inputId}-error`}
            className="mt-1.5 text-xs font-bold text-[var(--error)]"
            role="alert"
          >
            {error}
          </p>
        )}
      </div>
    );
  },
);
Select.displayName = "Select";

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(
  ({ label, className = "", id, ...props }, ref) => {
    const inputId = id || props.name;
    return (
      <label htmlFor={inputId} className="flex cursor-pointer items-start gap-3">
        <input
          ref={ref}
          type="checkbox"
          id={inputId}
          className={`mt-0.5 h-4 w-4 rounded border-white/20 bg-transparent text-[var(--cyan)] accent-[var(--cyan)] focus:ring-2 focus:ring-[var(--cyan)] focus:ring-offset-2 focus:ring-offset-[var(--bg)] ${className}`}
          {...props}
        />
        {label && <span className="text-sm font-medium text-[var(--text-secondary)]">{label}</span>}
      </label>
    );
  },
);
Checkbox.displayName = "Checkbox";

export function Label({
  children,
  htmlFor,
  required,
  className = "",
  ...props
}: LabelHTMLAttributes<HTMLLabelElement> & { required?: boolean }) {
  return (
    <label
      htmlFor={htmlFor}
      className={`mb-2 block text-sm font-bold text-[var(--text-secondary)] ${className}`}
      {...props}
    >
      {children}
      {required && (
        <span className="ml-1 text-[var(--error)]" aria-hidden="true">
          *
        </span>
      )}
    </label>
  );
}
