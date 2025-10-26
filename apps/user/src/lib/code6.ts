// apps/user/src/lib/code6.ts
// 6桁コード専用: 数字のみ抽出し、左ゼロ埋めで6桁に揃える
export const normalizeCode6 = (v: unknown): string => {
  const digits = String(v ?? "").replace(/\D/g, "");
  if (digits.length === 6) return digits;
  if (digits.length < 6) return digits.padStart(6, "0");
  // 6桁より長い場合は末尾の6桁を使用（不一致比較用の仕様を踏襲）
  return digits.slice(-6);
};
