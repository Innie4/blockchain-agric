import type { TextareaHTMLAttributes } from "react";

export interface TextAreaProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "className"> {
  className?: string;
  invalid?: boolean;
}

/** A multi-line text control, for descriptions and notes. */
export function TextArea({
  className,
  invalid,
  rows = 4,
  "aria-invalid": ariaInvalid,
  ...rest
}: TextAreaProps) {
  const classes = ["textarea", className]
    .filter((value): value is string => value !== null && value !== undefined)
    .join(" ");

  return (
    <textarea
      rows={rows}
      className={classes}
      aria-invalid={invalid === true ? true : ariaInvalid}
      {...rest}
    />
  );
}
