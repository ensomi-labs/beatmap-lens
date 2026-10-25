/**
 * Anonymous proposal colours, readable on the dark stage. Red (the playhead), white (marks) and
 * grey (the spectrogram) are left out. The service's colour indexes count into this list.
 */
export const proposalPalette = [
  { name: "orange", colour: "#ff9f1c" },
  { name: "green", colour: "#2ec27e" },
  { name: "purple", colour: "#b07cff" },
  { name: "cyan", colour: "#2bd2ff" },
  { name: "pink", colour: "#ff6fb5" },
  { name: "yellow", colour: "#f5d90a" },
  { name: "blue", colour: "#5b8cff" },
  { name: "lime", colour: "#a6e22e" },
  { name: "tan", colour: "#e0a370" },
] as const;

export function proposalColour(index: number) {
  return proposalPalette[index % proposalPalette.length] ?? proposalPalette[0];
}
