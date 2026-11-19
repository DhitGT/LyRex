export interface WorkerProgress {
  key: string
  message: string
  percent?: number
}

export type ReportProgress = (progress: WorkerProgress) => void
export type Stage = 'decode' | 'separate'
export interface WorkerResult {
  durationMs?: number
  error?: string
}
export type WorkerMessage =
  | { progress: WorkerProgress }
  | { result: WorkerResult }
  | { failure: string }
