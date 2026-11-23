import { computeSpectrogram } from "./spectrogram";

self.onmessage = (event: MessageEvent<Parameters<typeof computeSpectrogram>[0]>) => {
  const result = computeSpectrogram(event.data);
  (self as unknown as Worker).postMessage(result, [result.db.buffer]);
};
