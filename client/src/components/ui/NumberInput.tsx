import { TextInput, type TextInputProps } from "./TextInput";

export interface NumberInputProps extends Omit<TextInputProps, "type"> {
  min?: number;
  max?: number;
  step?: number | "any";
  inputMode?: TextInputProps["inputMode"];
}

/**
 * A numeric control. The value stays a string on the event, so a half-typed
 * number like `-` is not destroyed before it can be finished.
 */
export function NumberInput({
  className,
  min,
  max,
  step,
  inputMode = "decimal",
  ...rest
}: NumberInputProps) {
  return (
    <TextInput
      type="number"
      className={className}
      inputMode={inputMode}
      {...(min === undefined ? {} : { min })}
      {...(max === undefined ? {} : { max })}
      {...(step === undefined ? {} : { step })}
      {...rest}
    />
  );
}
