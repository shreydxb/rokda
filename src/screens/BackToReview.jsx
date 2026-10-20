import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { reviewReturn } from '../lib/monthlyReview';
import './BackToReview.css';

// "Back to the September review", on a page one of the review's links opened
// (lib/monthlyReview.js, withReviewReturn). Doing a check means leaving the
// review for the records, a statement or a balance; this is the way back to
// the next one without finding the tab again. It goes once a tab is changed,
// which starts the page afresh.
export default function BackToReview() {
  const [params] = useSearchParams();
  const now = useMemo(() => new Date(), []);
  const back = reviewReturn(params, now);
  if (!back) return null;
  return (
    <Link className="ov-link rv-back" to={back.href}>
      ← Back to the {back.label} review
    </Link>
  );
}
