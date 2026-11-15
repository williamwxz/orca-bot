// The panel-to-worker contract.
export type Status = { ok: false; message: string }

export type Requests = {
  status: { input: Record<string, never>; output: Status }
}
