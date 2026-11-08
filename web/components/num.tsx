/** Tabular figures widen punctuation too, so `.p` pulls it back in. Use it for every cell of a figures table. */
export function Num({ children }: { children: string }) {
  const parts = children.split(/([,.:])/);
  return (
    <>
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          <span key={index} className="p">
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </>
  );
}
