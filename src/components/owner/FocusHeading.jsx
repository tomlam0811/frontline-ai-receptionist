import { useEffect, useRef } from 'react';

/** A heading that takes focus when it appears, so a screen reader announces the new state (design spec: focus after navigation). */
export function FocusHeading({ as: Tag = 'h2', children, ...props }) {
  const ref = useRef(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return <Tag ref={ref} tabIndex={-1} className="owner-focus-heading" {...props}>{children}</Tag>;
}
