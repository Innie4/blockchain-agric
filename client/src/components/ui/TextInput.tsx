import type { InputHTMLAttributes, ReactNode } from "react";

export interface TextInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "className"> {
  className?: string;
  /** Marks the control invalid. `Field` sets this from its `error` prop. */
  invalid?: boolean;
  /** A short unit or prefix shown inside the field, e.g. `kg`. */
  addon?: ReactNode;
}

/** A single-line text control. Labelled and described through `Field`. */
export function TextInput({
  className,
  invalid,
  addon,
  type = "text",
  "aria-invalid": ariaInvalid,
  ...rest
}: TextInputProps) {
  const classes = ["input", className]
    .filter((value): value is string => value !== null && value !== undefined)
    .join(" ");

  const control = (
    <input
      type={type}
      className={classes}
      aria-invalid={invalid === true ? true : ariaInvalid}
      {...rest}
    />
  );

  if (addon === undefined) return control;

  return (
    <span className="input-group">
      {control}
      <span className="input-group__addon">{addon}</span>
    </span>
  );
}
