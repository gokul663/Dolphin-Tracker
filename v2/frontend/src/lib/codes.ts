/** The codes (or stick numbers) in one entry, like the server's `split_codes`: "DD-HJGK7Z. DD-HB8P6I" is two.
 *  Spaces alone separate only code-sized pieces, so "DD - ABC123" stays one. */
export function splitCodes(value: string): string[] {
  return value
    .split(/[,;|/\n]+|\.(?=\s|$)/)
    .map((part) => part.trim().replace(/^[.\s]+|[.\s]+$/g, ""))
    .filter(Boolean)
    .flatMap((part) => {
      const tokens = part.split(/\s+/);
      return tokens.length > 1 && tokens.every((token) => token.length >= 5) ? tokens : [part];
    });
}
