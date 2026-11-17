import { useEffect, useRef } from 'react';
import { formatDateTime } from '../../pages/owner/format.js';
import './feedback.css';

/**
 * PO-DC12. Shown only after the server confirmed the submit. It never says the issue will be fixed.
 * @param {{title?: string, receipt: {feedbackId: string, receivedAt: string}, children?: import('react').ReactNode, action?: import('react').ReactNode}} props
 */
export default function ReceiptCard({ title = 'Sent to the team', receipt, children, action }) {
  const heading = useRef(null);
  useEffect(() => { heading.current?.focus(); }, []);
  return <section className="owner-card owner-card--quiet owner-receipt" aria-labelledby="owner-receipt-title">
    <div className="owner-receipt__head">
      <span className="owner-notice__icon" aria-hidden="true">✓</span>
      <h2 id="owner-receipt-title" ref={heading} tabIndex={-1}>{title}</h2>
    </div>
    <p>{children}</p>
    <p className="owner-muted">Reference {String(receipt.feedbackId).slice(0, 8)}. {formatDateTime(receipt.receivedAt)}</p>
    {action}
  </section>;
}
