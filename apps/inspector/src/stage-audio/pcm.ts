/**
 * Splits an `f32le-interleaved` payload into one array per channel, bit for bit. No decoder,
 * resampler, clamp or downmix touches the values; samples above full scale are kept. The payload
 * is read in the platform's byte order, which is little-endian on every machine this runs on.
 */
export function deinterleave(bytes: ArrayBuffer, channels: number, frames: number): Float32Array[] {
  if (bytes.byteLength !== frames * channels * 4)
    throw new Error("The PCM payload's size does not match its frames and channels.");
  const interleaved = new Float32Array(bytes);
  return Array.from({ length: channels }, (_, channel) => {
    const data = new Float32Array(frames);
    for (let frame = 0, at = channel; frame < frames; frame++, at += channels)
      data[frame] = interleaved[at] as number;
    return data;
  });
}
