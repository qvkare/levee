/** The only badge on the site, because it is a state. Anything not read from a chain is a simulation. */
export function StateTag({ state }: { state: "Live" | "Simulation" }) {
  return (
    <span className="state-tag" data-live={state === "Live"}>
      {state}
    </span>
  );
}
