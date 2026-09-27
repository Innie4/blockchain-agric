/**
 * Base58, the encoding Solana uses for every address and signature.
 *
 * Implemented here rather than imported so the mock transport has no dependency
 * on which base58 package happens to be hoisted into the workspace. The client
 * and the API both ship their own copy, and this one is tested against them only
 * by agreeing on output.
 */

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

const INDEX: ReadonlyMap<string, number> = new Map(
  [...ALPHABET].map((character, index) => [character, index] as const)
);

/** Encodes bytes as base58. */
export function encodeBase58(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";

  let leadingZeros = 0;
  while (leadingZeros < bytes.length && (bytes[leadingZeros] as number) === 0) {
    leadingZeros += 1;
  }

  // Big-endian byte string to base-58 digits, by repeated division.
  const digits: number[] = [];
  for (const byte of bytes) {
    let carry = byte;
    for (let index = 0; index < digits.length; index += 1) {
      carry += (digits[index] as number) << 8;
      digits[index] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }

  let out = "1".repeat(leadingZeros);
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    out += ALPHABET[digits[index] as number];
  }
  return out;
}

/** Decodes base58 back to bytes. Throws on a character outside the alphabet. */
export function decodeBase58(value: string): Uint8Array {
  if (value.length === 0) return new Uint8Array(0);

  let leadingOnes = 0;
  while (leadingOnes < value.length && value[leadingOnes] === "1") {
    leadingOnes += 1;
  }

  const bytes: number[] = [];
  for (const character of value) {
    const digit = INDEX.get(character);
    if (digit === undefined) throw new Error(`"${character}" is not a base58 character.`);
    let carry = digit;
    for (let index = 0; index < bytes.length; index += 1) {
      carry += (bytes[index] as number) * 58;
      bytes[index] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  const out = new Uint8Array(leadingOnes + bytes.length);
  for (let index = 0; index < leadingOnes; index += 1) out[index] = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    out[leadingOnes + index] = bytes[bytes.length - 1 - index] as number;
  }
  return out;
}
