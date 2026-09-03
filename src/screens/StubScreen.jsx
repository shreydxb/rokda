export default function StubScreen({ title }) {
  return (
    <div>
      <h1 className="fig" style={{ fontSize: 28, fontWeight: 400, margin: '0 0 8px' }}>
        {title}
      </h1>
      <p style={{ color: 'var(--ink2)', fontSize: 13.5 }}>Coming up in a later phase.</p>
    </div>
  );
}
