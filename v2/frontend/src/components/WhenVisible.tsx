import { useEffect, useRef, useState, type ReactNode } from "react";

/** Renders its content once it first scrolls near the view, and keeps it from then on (a Google map, say: a
 *  billed load, so it waits until it is seen). Without IntersectionObserver (old browsers, tests) it renders at once. */
export function WhenVisible({ placeholder, children }: { placeholder: ReactNode; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const node = ref.current;
    if (seen || !node) return;
    const observer = new IntersectionObserver((entries) => entries.some((entry) => entry.isIntersecting) && setSeen(true), { rootMargin: "200px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [seen]);
  return <div ref={ref}>{seen ? children : placeholder}</div>;
}
