/** A 1 px track with the value printed beside the control, not inside the thumb. */
export function Slider(props: {
  id: string;
  name?: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  describedBy?: string;
  onChange: (value: number) => void;
}) {
  return (
    <div className="slider">
      <div className="slider-head">
        <label htmlFor={props.id}>{props.label}</label>
        <output htmlFor={props.id} className="slider-value">
          {props.display}
        </output>
      </div>
      <input
        id={props.id}
        name={props.name}
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        aria-valuetext={props.display}
        aria-describedby={props.describedBy}
        onChange={(event) => props.onChange(Number(event.target.value))}
      />
    </div>
  );
}
