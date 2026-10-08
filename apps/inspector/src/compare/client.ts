const prefix = "/api/inspector/comparisons";

export async function comparisonRequest(operation: string, body: unknown): Promise<Response> {
  const response = await fetch(`${prefix}/${operation}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Beatmap-Lens-Local": "1" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error((await response.json()).error);
  return response;
}

export async function comparisonJson<T>(operation: string, body: unknown): Promise<T> {
  return (await comparisonRequest(operation, body)).json();
}

export function formatComparisonTime(ms: number): string {
  return `${Math.floor(ms / 60_000)}:${((ms % 60_000) / 1000).toFixed(1).padStart(4, "0")}`;
}
