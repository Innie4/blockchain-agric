import { cloneElement, type ReactElement } from "react";
import { Icon } from "./Icon";

/**
 * The accessibility contract every control must satisfy. `Field` fills these in
 * on whichever element it is given, so a control never has to know how it is
 * described or whether it is currently invalid.
 */
export interface FieldControlProps {
  id?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean | "true" | "false";
  "aria-required"?: boolean | "true" | "false";
}

export interface FieldProps {
  /** Must be unique on the page: it is what the label points at. */
  id: string;
  label: string;
  hint?: string;
  error?: string | null;
  required?: boolean;
  /** Shown next to the label for a field that may be left blank. */
  optional?: boolean;
  className?: string;
  children: ReactElement<FieldControlProps>;
}

/**
 * Wires a label, hint and error message to a control.
 *
 * The control is cloned with the right `id` and `aria-describedby` rather than
 * asking every caller to repeat them, which is where accessible forms usually
 * go wrong.
 */
export function Field({
  id,
  label,
  hint,
  error,
  required = false,
  optional = false,
  className,
  children,
}: FieldProps) {
  const hintId = hint === undefined ? undefined : `${id}-hint`;
  const errorId = error === undefined || error === null ? undefined : `${id}-error`;

  const describedBy = [children.props["aria-describedby"], hintId, errorId]
    .filter((value): value is string => value !== undefined && value.length > 0)
    .join(" ");

  const control = cloneElement(children, {
    id,
    ...(describedBy.length > 0 ? { "aria-describedby": describedBy } : {}),
    "aria-invalid": error !== undefined && error !== null ? true : undefined,
    ...(required ? { "aria-required": true } : {}),
  });

  return (
    <div
      className={["field", className]
        .filter((value): value is string => value !== null && value !== undefined)
        .join(" ")}
    >
      <label className="field__label" htmlFor={id}>
        {label}
        {required ? (
          <span className="field__required" aria-hidden="true">
            *
          </span>
        ) : null}
        {optional ? <span className="field__optional">(optional)</span> : null}
      </label>

      {control}

      {hint !== undefined ? (
        <p className="field__hint" id={hintId}>
          {hint}
        </p>
      ) : null}

      {error !== undefined && error !== null ? (
        <p className="field__error" id={errorId}>
          <Icon name="alertTriangle" size={14} />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
}
