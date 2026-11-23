import {
  computeSpectrogram,
  type SpectrogramWorkerRequest,
  type SpectrogramWorkerResponse,
} from "./spectrogram";

self.onmessage = (event: MessageEvent<SpectrogramWorkerRequest>) => {
  const { requestId, ...input } = event.data;
  const result = computeSpectrogram(input);
  const response: SpectrogramWorkerResponse =
    requestId !== undefined ? { ...result, requestId } : result;
  (self as unknown as Worker).postMessage(response, [result.db.buffer]);
};
