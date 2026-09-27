/**
 * Binary conversions used by the sign-in handshake and the two-phase
 * blockchain flow. Implemented here rather than pulled from a dependency so the
 * encodings cannot drift between the client and the server.
 */

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_ZERO = "1";

/** Base58 digits, least significant byte first. */
function toBase58Digits(value: string): number[] {
  const digits: number[] = [0];
  for (let index = 0; index < value.length; index += 1) {
    const char = value.charAt(index);
    const digit = BASE58_ALPHABET.indexOf(char);
    if (digit < 0) {
      throw new Error(`"${char}" is not a valid base58 character.`);
    }
    let carry = digit;
    for (let i = 0; i < digits.length; i += 1) {
      carry += digits[i] * 58;
      digits[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      digits.push(carry & 0xff);
      carry >>= 8;
    }
  }
  return digits;
}

/**
 * Decodes base58.
 *
 * A few injected wallets return a message signature as base58 rather than as
 * bytes, and the server accepts either, so this is what turns that answer into
 * something the application can re-encode consistently.
 */
export function base58ToBytes(value: string): Uint8Array {
  if (value.length === 0) return new Uint8Array(0);
  const digits = toBase58Digits(value);

  let leadingZeros = 0;
  while (leadingZeros < value.length && value.charAt(leadingZeros) === BASE58_ZERO) {
    leadingZeros += 1;
  }

  const bytes = new Uint8Array(leadingZeros + digits.length);
  for (let i = 0; i < leadingZeros; i += 1) bytes[i] = 0;
  for (let i = 0; i < digits.length; i += 1) {
    bytes[leadingZeros + i] = digits[digits.length - 1 - i];
  }
  return bytes;
}

/** `btoa` is given the bytes in chunks, because spreading a whole megabyte of
 * arguments into one call overflows the call stack. */
const BASE64_CHUNK = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";
  if (typeof btoa !== "function") {
    throw new Error("This browser cannot encode base64 data.");
  }
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK) {
    const chunk = bytes.subarray(offset, offset + BASE64_CHUNK);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  if (value.length === 0) return new Uint8Array(0);
  if (typeof atob !== "function") {
    throw new Error("This browser cannot decode base64 data.");
  }
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** The exact bytes of the sign-in challenge, which is what the wallet must sign. */
export function utf8ToBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}
