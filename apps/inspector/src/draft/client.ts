const prefix = "/api/draft";

/** Calls the local Draft service; a failure carries the service's error name and message. */
export async function draftRequest(
  operation: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  const response = await fetch(`${prefix}/${operation}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Beatmap-Lens-Local": "1" },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    const failure: { name: string; error: string } = await response.json();
    throw Object.assign(new Error(failure.error), { name: failure.name });
  }
  return response;
}

export async function draftJson<T>(
  operation: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<T> {
  return (await draftRequest(operation, body, signal)).json();
}

/** Splits interleaved float32 PCM into channels. */
export function deinterleave(bytes: ArrayBuffer, channels: number): Float32Array[] {
  const samples = new Float32Array(bytes);
  const frames = Math.floor(samples.length / channels);
  return Array.from({ length: channels }, (_, channel) => {
    const data = new Float32Array(frames);
    for (let frame = 0; frame < frames; frame++)
      data[frame] = samples[frame * channels + channel] as number;
    return data;
  });
}
