import { useEffect, useState } from "react";

/**
 * Over the viewer from the moment an image is asked for until its first tiles are drawn: a large slide on slow storage can take a long
 * time to open, and an empty black canvas looks like a failure. After a few seconds it says that it is still working.
 */
export function OpeningSpinner({ name }: { name?: string }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setSlow(true), 6000);
    return () => window.clearTimeout(t);
  }, []);
  return (
    <div className="opening" role="status" aria-label="Opening the image" data-testid="opening">
      <div className="opening-box glass">
        <span className="spinner big" />
        <div>
          <strong>Opening{name ? ` ${name}` : " the image"}…</strong>
          {slow && <div className="muted small">Still working: large slides on slow storage can take a minute the first time.</div>}
        </div>
      </div>
    </div>
  );
}
