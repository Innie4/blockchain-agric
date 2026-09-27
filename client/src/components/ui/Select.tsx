import type { SelectHTMLAttributes } from "react";
import { Icon } from "./Icon";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "className"> {
  className?: string;
  options: readonly SelectOption[];
  invalid?: boolean;
  /** Shown as the first entry, with an empty value. */
  placeholder?: string;
}

/**
 * A native select, styled. A native control is deliberate: it behaves the way
 * a phone keyboard and a screen reader both expect, and this project's options
 * are always short enough to list.
 */
export function Select({
  className,
  options,
  invalid,
  placeholder,
  "aria-invalid": ariaInvalid,
  ...rest
}: SelectProps) {
  const classes = ["select", className]
    .filter((value): value is string => value !== null && value !== undefined)
    .join(" ");

  return (
    <span className="select-wrapper">
      <select
        className={classes}
        aria-invalid={invalid === true ? true : ariaInvalid}
        {...rest}
      >
        {placeholder === undefined ? null : (
          <option value="">{placeholder}</option>
        )}
        {options.map((option) => (
          <option
            key={option.value}
            value={option.value}
            {...(option.disabled === true ? { disabled: true } : {})}
          >
            {option.label}
          </option>
        ))}
      </select>
      <Icon name="chevronRight" size={16} className="select-wrapper__marker" />
    </span>
  );
}
