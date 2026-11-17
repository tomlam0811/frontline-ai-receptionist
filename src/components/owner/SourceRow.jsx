import { Icon } from './ui.jsx';
import { detailCountText, nameOf, sourceKind } from './source-names.js';
import { formatDay } from '../../pages/owner/format.js';
import './source-row.css';

/** The one muted line under a source's name: "Website · Added Aug 31 · 4 details". Parts that are not known are left out. */
export function sourceMeta(source, detailCount) {
  return [sourceKind(source.type).label, source.addedAt ? `Added ${formatDay(source.addedAt)}` : '', detailCountText(detailCount)].filter(Boolean).join(' · ');
}

/**
 * One knowledge source as a list row: a tile with the source type's icon, the name, one muted line, and on the right an
 * action. `checkbox` puts a checkbox at the far left and makes the whole row one label. `usedBy` is a list of receptionist
 * names added to the same muted line. Render it inside a `ul.owner-source-list`.
 * @param {any} props `source`, `detailCount`, `usedBy`, `action` and `checkbox`.
 */
export default function SourceRow({ source, detailCount = 0, usedBy = [], action = null, checkbox = null }) {
  const Main = checkbox ? 'label' : 'div';
  return <li className="owner-source-row">
    <Main className="owner-source-row__main">
      {checkbox}
      <span className="owner-source-row__tile" aria-hidden="true"><Icon name={sourceKind(source.type).icon} /></span>
      <span className="owner-source-row__text">
        <span className="owner-source-row__name">{nameOf(source)}</span>
        <span className="owner-source-row__meta">{[sourceMeta(source, detailCount), usedBy.length > 0 ? `Used by ${usedBy.join(', ')}` : ''].filter(Boolean).join(' · ')}</span>
      </span>
    </Main>
    {action}
  </li>;
}
