// Development-only stand-in for the model that reads typed or dictated text. It splits the text into
// sentences and files each under a category by keyword. The quote of every fact is the sentence itself,
// so the same verbatim-quote rule the real extractor is held to applies here too. It is not used in
// production and it is not a substitute for testing the real extractor.

const RULES = [
  ['office_hours', /\b(open|close|closed|hours?|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b.*\b(\d{1,2}(?::\d{2})?\s?(?:am|pm)|noon|midnight)\b/i],
  ['pricing_quote_policy', /(\$\s?\d|\bprice|\bcost|\bfree quote|\bestimate\b)/i],
  ['booking_cancellation_policy', /\b(cancel|reschedul|no-show|deposit|policy|policies)\b/i],
  ['locations_service_area', /\b(located|address|we serve|service area|serving|street|avenue|suite)\b/i],
  ['services', /\b(we (?:also )?(?:offer|provide|do|fix|repair|install|clean)|services? include|specializ)/i],
  ['identity_contact', /\b(phone|call us|email|contact)\b/i],
  ['faq', /\?/],
];

export function heuristicExtract(text) {
  const sentences = String(text).split(/(?<=[.!?])\s+|\n+/).map((sentence) => sentence.trim()).filter((sentence) => sentence.length > 8);
  return sentences.map((sentence) => {
    const group = RULES.find(([, pattern]) => pattern.test(sentence))?.[0] ?? 'other';
    return { group, value: sentence.slice(0, 1000), scope: '', quote: sentence, uncertain: group === 'other' };
  });
}
