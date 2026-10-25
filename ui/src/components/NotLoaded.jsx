/**
 * What a page that counts applications shows before the first list lands. There is nothing to count
 * and nothing to offer yet: an unreachable manager is an outage, and saying "nothing configured" to
 * it would send someone to recreate what they have.
 */
import EmptyState from './EmptyState.jsx';

/** @param {{unreachable: boolean, onRetry: () => void}} props */
export default function NotLoaded({ unreachable, onRetry }) {
  if (!unreachable) {
    return (
      <p className="empty-inline" role="status">
        Loading…
      </p>
    );
  }
  return (
    <EmptyState
      icon="alert"
      title="Can't reach Paddock"
      action={
        <button type="button" className="btn primary" onClick={onRetry}>
          Retry
        </button>
      }
    >
      The dashboard is up but the manager behind it is not answering. Your applications are unchanged.
    </EmptyState>
  );
}
