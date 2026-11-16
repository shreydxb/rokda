import { useNow } from '../lib/useNow';
import { Link, useSearchParams } from 'react-router-dom';
import { reviewReturn } from '../lib/monthlyReview';
import './BackToReview.css';

// "Back to Month end for September", on a page one of Month end's links
// opened (lib/monthlyReview.js, withReviewReturn). Doing a check can mean
// leaving Month end for the records or a balance; this is the way back to the
// next one without finding the tab again. It goes once a tab is changed,
// which starts the page afresh.
export default function BackToReview() {
  const [params] = useSearchParams();
  const now = useNow();
  const back = reviewReturn(params, now);
  if (!back) return null;
  return (
    <Link className="ov-link rv-back" to={back.href}>
      ← Back to Month end for {back.label}
    </Link>
  );
}
