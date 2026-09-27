import { useRef, useState, type ChangeEvent } from "react";
import { formatBytes } from "../../lib/format";
import { Icon } from "./Icon";

export interface FileInputProps {
  id: string;
  label: string;
  hint?: string;
  error?: string | null;
  required?: boolean;
  /** An `accept` string, e.g. `image/jpeg,image/png,application/pdf`. */
  accept?: string;
  multiple?: boolean;
  disabled?: boolean;
  name?: string;
  /** The current selection. The component never holds files of its own. */
  files: readonly File[];
  onFilesChange: (files: File[]) => void;
  /** The server rejects more than this in one request. */
  maxFiles?: number;
  /** The server rejects anything larger than this. */
  maxSizeBytes?: number;
}

/**
 * A file control that shows exactly what has been chosen.
 *
 * This renders its own label, hint and error rather than sitting inside
 * `Field`, because the selection list is a sibling of the input and `Field` can
 * only describe one element. The native file input is left visible on purpose:
 * it is the control every operating system already teaches people to use.
 * Sizes and counts are checked here as well as on the server, so an oversized
 * file is refused before it is uploaded rather than after.
 */
export function FileInput({
  id,
  label,
  hint,
  error,
  required = false,
  accept,
  multiple = false,
  disabled = false,
  name,
  files,
  onFilesChange,
  maxFiles,
  maxSizeBytes,
}: FileInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const hintId = hint === undefined ? undefined : `${id}-hint`;
  const hasMessage = localError !== null || (error !== undefined && error !== null);
  const errorId = hasMessage ? `${id}-error` : undefined;
  const listId = files.length > 0 ? `${id}-files` : undefined;

  const describedBy = [hintId, errorId, listId]
    .filter((value): value is string => value !== undefined)
    .join(" ");
  const message = localError ?? error ?? null;

  function handleChange(event: ChangeEvent<HTMLInputElement>): void {
    const chosen = Array.from(event.target.files ?? []);
    setLocalError(null);

    if (maxFiles !== undefined && chosen.length > maxFiles) {
      setLocalError(
        `Choose no more than ${maxFiles} file${maxFiles === 1 ? "" : "s"} in one upload.`,
      );
      event.target.value = "";
      return;
    }

    const tooLarge =
      maxSizeBytes === undefined
        ? undefined
        : chosen.find((file) => file.size > maxSizeBytes);
    if (tooLarge !== undefined) {
      setLocalError(
        `${tooLarge.name} is ${formatBytes(tooLarge.size)}. The limit for one file is ` +
          `${formatBytes(maxSizeBytes)}.`,
      );
      event.target.value = "";
      return;
    }

    onFilesChange(multiple ? chosen : chosen.slice(0, 1));
  }

  function removeFile(index: number): void {
    onFilesChange(files.filter((_file, position) => position !== index));
    if (inputRef.current !== null) inputRef.current.value = "";
  }

  return (
    <div className="file-input">
      <label className="field__label" htmlFor={id}>
        {label}
        {required ? (
          <span className="field__required" aria-hidden="true">
            *
          </span>
        ) : null}
      </label>

      <span className="file-input__control">
        <input
          ref={inputRef}
          id={id}
          type="file"
          {...(name === undefined ? {} : { name })}
          {...(accept === undefined ? {} : { accept })}
          {...(multiple ? { multiple: true } : {})}
          {...(disabled ? { disabled: true } : {})}
          {...(describedBy.length > 0 ? { "aria-describedby": describedBy } : {})}
          aria-invalid={message !== null ? true : undefined}
          aria-required={required || undefined}
          onChange={handleChange}
        />
      </span>

      {hint !== undefined ? (
        <p className="field__hint" id={hintId}>
          {hint}
        </p>
      ) : null}

      {files.length > 0 ? (
        <ul className="file-input__list" id={listId}>
          {files.map((file, index) => (
            <li className="file-input__entry" key={`${file.name}-${file.size}-${index}`}>
              <span className="truncate">{file.name}</span>
              <span className="cluster cluster--tight">
                <span className="nowrap">{formatBytes(file.size)}</span>
                <button
                  type="button"
                  className="btn btn--quiet btn--sm"
                  disabled={disabled}
                  onClick={() => removeFile(index)}
                >
                  <Icon name="x" size={14} />
                  <span className="visually-hidden">Remove {file.name}</span>
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {message !== null ? (
        <p className="field__error" id={errorId}>
          <Icon name="alertTriangle" size={14} />
          <span>{message}</span>
        </p>
      ) : null}
    </div>
  );
}
