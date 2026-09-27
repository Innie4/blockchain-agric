import { TextInput, type TextInputProps } from "./TextInput";

export interface DateInputProps extends Omit<TextInputProps, "type"> {
  /** The latest date the server will accept, as `YYYY-MM-DD`. */
  max?: string;
  /** The earliest date the server will accept, as `YYYY-MM-DD`. */
  min?: string;
}

/**
 * A calendar date. The value is always the `YYYY-MM-DD` string an input of this
 * type produces, and is sent to the server as an ISO timestamp by the caller.
 */
export function DateInput({ className, ...rest }: DateInputProps) {
  return (
    <TextInput
      type="date"
      className={className}
      // A readable placeholder, for the browser that does not show one.
      placeholder="YYYY-MM-DD"
      {...rest}
    />
  );
}
