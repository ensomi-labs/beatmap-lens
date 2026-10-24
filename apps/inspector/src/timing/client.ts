const prefix = "/api/inspector/timing";

/** Calls the local timing service; a failure carries the service's message. */
export async function timingRequest(operation: string, body: unknown): Promise<Response> {
  const response = await fetch(`${prefix}/${operation}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Beatmap-Lens-Local": "1" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error((await response.json()).error);
  return response;
}

export async function timingJson<T>(operation: string, body: unknown): Promise<T> {
  return (await timingRequest(operation, body)).json();
}
