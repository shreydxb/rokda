import { failedSources, failureMessage, labelFor } from '../lib/loadState';

// A load failure is shown, not swallowed. When values from an earlier load are
// still on screen, say so and say when they are from — "possibly stale" is a
// different claim from "this is your data" (QA-10).
export default function LoadFailure({ errors, loadedAt, onRetry }) {
  const failed = failedSources(errors);
  if (failed.length === 0) return null;
  return (
    <div className="ov-error" role="alert">
      <span>
        {failureMessage(errors)}{' '}
        {loadedAt
          ? `Showing what loaded at ${loadedAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} — ${failed
              .map(labelFor)
              .join(', ')} may be missing or out of date.`
          : 'Nothing could be loaded for those.'}
      </span>
      {onRetry && (
        <button type="button" className="om-btn" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}
