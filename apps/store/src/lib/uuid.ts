// apps/store/src/lib/uuid.ts
// UUID v4 などを許容する簡易検証
export function isUuidLike(value: string | null | undefined): boolean {
  const s = String(value || '').trim();
  if (!s) return false;
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/.test(s);
}

