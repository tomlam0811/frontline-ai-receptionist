// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import SourceRow, { sourceMeta } from '../../src/components/owner/SourceRow.jsx';
import { detailCountText, sourceKind } from '../../src/components/owner/source-names.js';

// The one row every source list uses: tile with a type icon, name, one muted line, then the action.
const renderRow = (props) => render(<ul className="owner-source-list"><SourceRow {...props} /></ul>);

describe('Source type labels and icons', () => {
  it('maps each source type to a label and an icon, and anything else to a file', () => {
    expect(['website', 'owner_url'].map((type) => sourceKind(type))).toEqual([{ label: 'Website', icon: 'globe' }, { label: 'Website', icon: 'globe' }]);
    expect(sourceKind('owner_document')).toEqual({ label: 'File', icon: 'document' });
    expect(['owner_form', 'owner_text'].map((type) => sourceKind(type))).toEqual([{ label: 'Note', icon: 'note' }, { label: 'Note', icon: 'note' }]);
    expect(sourceKind('owner_dictation')).toEqual({ label: 'Recording', icon: 'mic' });
    expect(sourceKind('something_new')).toEqual({ label: 'File', icon: 'document' });
  });

  it('says "detail" or "details" and leaves the count out when it is 0 or unknown', () => {
    expect([detailCountText(4), detailCountText(1), detailCountText(0), detailCountText(undefined)]).toEqual(['4 details', '1 detail', '', '']);
  });
});

describe('SourceRow', () => {
  const website = { sourceId: 's1', type: 'website', label: 'riverside.example', addedAt: '2026-08-31T15:00:00Z' };

  it('shows the name and one meta line of type, date and detail count', () => {
    renderRow({ source: website, detailCount: 4 });
    expect(screen.getByText('riverside.example')).toHaveClass('owner-source-row__name');
    expect(screen.getByText(/^Website · Added [A-Z][a-z]{2} \d{1,2} · 4 details$/)).toHaveClass('owner-source-row__meta');
    expect(document.querySelector('.owner-source-row__tile svg')).toHaveAttribute('aria-hidden', 'true');
    expect(document.querySelector('.owner-source-row__tile')).toHaveAttribute('aria-hidden', 'true');
  });

  it('leaves out the date when there is none and the count when it is 0', () => {
    expect(sourceMeta({ type: 'owner_form', label: 'Your note' }, 0)).toBe('Note');
    expect(sourceMeta({ type: 'owner_dictation', addedAt: '2026-08-31T15:00:00Z' }, 1)).toMatch(/^Recording · Added [A-Z][a-z]{2} \d{1,2} · 1 detail$/);
  });

  it('adds the receptionists that use the source to the same line, and nothing when nobody does', () => {
    const { unmount } = renderRow({ source: website, detailCount: 1, usedBy: ['Blake', 'Sam'] });
    expect(screen.getByText(/ · Used by Blake, Sam$/)).toBeInTheDocument();
    unmount();
    renderRow({ source: website, detailCount: 1 });
    expect(screen.queryByText(/Used by/)).not.toBeInTheDocument();
  });

  it('puts the action on the right, and a checkbox at the far left inside one label', () => {
    const { unmount } = renderRow({ source: website, action: <button type="button" className="owner-source-row__action">Remove</button> });
    const row = screen.getByRole('listitem');
    expect(row.lastElementChild).toBe(screen.getByRole('button', { name: 'Remove' }));
    unmount();
    renderRow({ source: website, checkbox: <input type="checkbox" /> });
    const label = screen.getByRole('listitem').firstElementChild;
    expect(label.tagName).toBe('LABEL');
    expect(label.firstElementChild).toBe(screen.getByRole('checkbox'));
    expect(screen.getByRole('checkbox', { name: /riverside\.example/ })).toBeInTheDocument();
  });

  it('is styled as a card with a 40px 8px-radius tile, a truncating name and 8px gaps between rows', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/components/owner/source-row.css'), 'utf8');
    expect(css).toMatch(/\.owner-source-list\{[^}]*gap:8px/);
    expect(css).toMatch(/\.owner-source-row\{[^}]*padding:12px[^}]*border-radius:14px/);
    expect(css).toMatch(/\.owner-source-row__tile\{[^}]*width:40px;height:40px;border-radius:8px;background:var\(--mint-2\)/);
    expect(css).toMatch(/\.owner-source-row__name\{[^}]*white-space:nowrap;overflow:hidden;text-overflow:ellipsis/);
  });
});
