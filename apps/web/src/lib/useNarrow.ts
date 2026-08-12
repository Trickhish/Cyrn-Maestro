import { useEffect, useState } from "react";

/* True on phone-width screens.
 *
 * Layout belongs in CSS — this is only for the cases CSS cannot reach, chiefly
 * copy that has to get shorter rather than smaller. A placeholder truncated
 * mid-sentence reads as a bug; the same idea in four words does not.
 *
 * 768px is Tailwind's `md`, so this and the classNames around it stay in step. */
const QUERY = "(max-width: 767px)";

export function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window !== "undefined" && window.matchMedia(QUERY).matches,
  );

  useEffect(() => {
    const mql = window.matchMedia(QUERY);
    const onChange = (e: MediaQueryListEvent) => setNarrow(e.matches);
    mql.addEventListener("change", onChange);
    setNarrow(mql.matches);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return narrow;
}
