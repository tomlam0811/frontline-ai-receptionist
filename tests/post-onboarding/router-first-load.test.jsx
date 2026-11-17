// @vitest-environment jsdom
import { useEffect } from 'react';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { navigate, useLocation } from '../../src/pages/owner/router.jsx';

function Child() {
  useEffect(() => { navigate('/app', { replace: true }); }, []);
  return <p>Loading your progress</p>;
}

function Parent() {
  const { pathname } = useLocation();
  return pathname === '/app' ? <p>Owner home</p> : <Child />;
}

describe('owner router first load', () => {
  afterEach(() => window.history.replaceState({}, '', '/'));

  it('shows the new route when a child redirects during the first render', async () => {
    window.history.replaceState({}, '', '/?auth=google-complete');
    render(<Parent />);
    expect(await screen.findByText('Owner home')).toBeInTheDocument();
    expect(screen.queryByText('Loading your progress')).not.toBeInTheDocument();
  });
});
