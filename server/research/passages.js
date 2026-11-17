import { createHash } from 'node:crypto';

// "Fabricate" counts only as an instruction such as "fabricate facts": a plastics fabricator's home page says
// "custom-fabricated components" and was refused whole as an injection (portplastics.com, 2026-10-02).
const INJECTION = /(?:ignore|disregard).{0,30}(?:instruction|prompt)|system\s+(?:message|prompt)|developer\s+message|(?:you|assistant)\s+must\s+(?:say|claim|pretend|obey)|\bfabricate\s+(?:an?\s+|the\s+|some\s+)?(?:facts?|information|answers?|claims?|details|reviews?|testimonials?|data)\b/i;
const uuidFor = (value) => {
  const hex = createHash('sha256').update(value).digest('hex').slice(0, 32).split('');
  hex[12] = '4'; hex[16] = ((Number.parseInt(hex[16], 16) & 3) | 8).toString(16);
  return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`;
};

export function passagesFromResearch(research) {
  return (research?.pages ?? []).map((page, index) => {
    const text = String(page.excerpt ?? '').trim().slice(0, 12_000);
    const retrievedAt = page.retrievedAt ?? new Date().toISOString();
    const sourceId = uuidFor(`source:${page.finalUrl}:${retrievedAt}`);
    return Object.freeze({
      passageId: uuidFor(`passage:${sourceId}:${index}:${text}`),
      source: Object.freeze({ sourceId, url: page.finalUrl, retrievedAt }),
      text,
      hostile: INJECTION.test(text),
    });
  }).filter((passage) => passage.text);
}

export { uuidFor };
