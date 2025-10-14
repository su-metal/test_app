export type Preset = {
  slot_no: number;
  name: string;
  start_time: string; // "HH:MM:SS"
  end_time: string; // "HH:MM:SS"
  slot_minutes: number; // 10
};

const hhmmToMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};
const minutesToHHmm = (mins: number) => {
  const h = String(Math.floor(mins / 60)).padStart(2, "0");
  const m = String(mins % 60).padStart(2, "0");
  return `${h}:${m}`;
};

/** プリセットから刻みスロットを生成（end は含めない） */
export function buildSlots(preset: Preset) {
  const start = hhmmToMinutes(preset.start_time.slice(0, 5));
  const end = hhmmToMinutes(preset.end_time.slice(0, 5));
  const step = preset.slot_minutes;

  const out: { label: string; start: string; end: string }[] = [];
  for (let t = start; t + step <= end; t += step) {
    out.push({
      label: `${minutesToHHmm(t)}–${minutesToHHmm(t + step)}`,
      start: minutesToHHmm(t),
      end: minutesToHHmm(t + step),
    });
  }
  return out;
}
