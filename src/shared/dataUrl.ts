/**
 * Measuring an attachment that arrives already encoded.
 *
 * A file picked off disk is measured by `stat` before it is ever read, so the
 * size ceiling is checked against a number nobody had to compute. An attachment
 * that arrives as a `data:` URL — a forwarded message, an image pasted into the
 * composer — has no such handle, and decoding a 50 MB base64 string purely to
 * find out how big it is defeats the point of having a ceiling at all.
 *
 * Lives in `shared` rather than `main` so the arithmetic can be tested in plain
 * Node: this is what stands between the ceiling and an oversized attachment on
 * every path that does not go through a file picker.
 */

/**
 * The decoded byte length of a `data:` URL, computed from the encoded length.
 *
 * base64 is 4 characters per 3 bytes, less whatever padding is on the end. Any
 * string without a comma is treated as bare base64, so this is safe to call on
 * either form.
 */
export function dataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',');
  const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}
