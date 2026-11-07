import { useId } from "react";

/** Hatching means one thing: a gauge out of service. */
export function Hatch({ className }: { className?: string }) {
  const id = useId();
  return (
    <svg className={className} aria-hidden="true">
      <defs>
        <pattern id={id} width="9" height="9" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="9" stroke="currentColor" strokeWidth="2" />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill={`url(#${id})`} />
    </svg>
  );
}
