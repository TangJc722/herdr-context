// Rough token estimates for text that the logs carry without a token count.
// Only used to *split* a measured total into categories, never as a total.
// CJK characters count ~1 token each; other text ~4 characters per token.
const CJK = /[　-〿぀-ヿ㐀-䶿一-鿿가-힯＀-￯]/g;

export const IMAGE_TOKENS_ESTIMATE = 1600;

export function estimateTokens(value) {
  if (value == null) return 0;
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  if (!s) return 0;
  const cjk = (s.match(CJK) || []).length;
  return Math.ceil(cjk + (s.length - cjk) / 4);
}
