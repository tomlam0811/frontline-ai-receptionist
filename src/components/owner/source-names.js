// How a knowledge source is named on screen: its own label when it has one, otherwise the kind of source.

const TYPE_NAME = {
  website: 'Website', owner_form: 'Typed note', owner_text: 'Typed note', owner_dictation: 'Spoken note', owner_document: 'Document', owner_url: 'Web page',
};
export const typeName = (type) => TYPE_NAME[type] ?? 'Source';
export const nameOf = (source) => source.label || typeName(source.type);

/** How a source is shown in a row: the label after its name, and the icon in its tile. Anything unknown reads as a file. */
const KIND = {
  website: ['Website', 'globe'], owner_url: ['Website', 'globe'],
  owner_document: ['File', 'document'],
  owner_form: ['Note', 'note'], owner_text: ['Note', 'note'],
  owner_dictation: ['Recording', 'mic'],
};
export const sourceKind = (type) => { const [label, icon] = KIND[type] ?? ['File', 'document']; return { label, icon }; };

/** "4 details", "1 detail", or '' when there are none or the count is not known. */
export const detailCountText = (count) => (count > 0 ? `${count} ${count === 1 ? 'detail' : 'details'}` : '');

/** "1 fact", "12 facts" or "No facts": how much a source has told the receptionist. */
export const factCountText = (count) => (count === 0 ? 'No facts' : count === 1 ? '1 fact' : `${count} facts`);

/** "Sam", "Sam and Riley", "Sam, Riley and Jo". */
export function joinNames(names) {
  if (names.length < 2) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** The number of active facts each source supplied: `Map<sourceId, count>`, from the categories the Knowledge view returns. */
export function countFactsBySource(groups) {
  const counts = new Map();
  for (const group of groups) for (const entry of group.entries) counts.set(entry.sourceId, (counts.get(entry.sourceId) ?? 0) + 1);
  return counts;
}
