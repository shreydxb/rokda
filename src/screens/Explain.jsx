import './Explain.css';

// How a figure is worked out, kept one click away (docs/decisions.md, "The
// shell, and fewer words"). A block says what it is in a line at most; the
// rest of its explanation sits here, closed, so the screen reads calm. A
// warning, an error or a status is never put here: those stay in view.
export default function Explain({ label = 'How this is worked out', children }) {
  return (
    <details className="explain">
      <summary>{label}</summary>
      <div className="explain-body">{children}</div>
    </details>
  );
}
