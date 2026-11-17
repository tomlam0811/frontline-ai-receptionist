// The model extractor skipped powerwash.example's footer phone number and email in three of four reads on
// 2026-10-03. Phone numbers and emails have a fixed shape, so they are read straight from the page text instead,
// quoted exactly as published, and the evidence check admits them like any other quoted contact.
const PHONE = /(?<![\d+])(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PER_KIND = 3;

const phoneDigits = (text) => text.replace(/\D/g, '').slice(-10);

export function findPublishedContacts(passages, extracted = []) {
  const known = extracted.filter((fact) => fact.group === 'identity_contact').map((fact) => String(fact.value));
  const knownPhones = new Set(known.flatMap((value) => value.match(PHONE) ?? []).map(phoneDigits));
  const knownEmails = new Set(known.flatMap((value) => value.match(EMAIL) ?? []).map((email) => email.toLowerCase()));
  const found = [];
  for (const [pattern, seen, key] of [[PHONE, knownPhones, phoneDigits], [EMAIL, knownEmails, (email) => email.toLowerCase()]]) {
    let count = 0;
    for (const passage of passages) {
      for (const value of passage.text.match(pattern) ?? []) {
        if (count >= PER_KIND || seen.has(key(value))) continue;
        seen.add(key(value));
        count += 1;
        found.push({ group: 'identity_contact', kind: 'contact', scope: '', value, passageIds: [passage.passageId] });
      }
    }
  }
  return found;
}
