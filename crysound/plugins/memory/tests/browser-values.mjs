/** Serialize a value embedded in CDP JavaScript, including script delimiters and line separators.
 * @param {string} value Label inserted into a browser expression.
 * @returns {string} Escaped JavaScript string literal.
 */
export function browserValue(value) {
  const escapes = { '<': '\\u003c', '>': '\\u003e', '\u2028': '\\u2028', '\u2029': '\\u2029' };
  return JSON.stringify(value).replace(/[<>\u2028\u2029]/gu, character => escapes[character]);
}
