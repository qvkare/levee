import { Hatch } from "./hatch.tsx";

export function OutOfService({ message }: { message: string }) {
  return (
    <div className="out-of-service">
      <Hatch />
      <p>
        <span className="medium">Gauge out of service.</span> {message}
      </p>
    </div>
  );
}
