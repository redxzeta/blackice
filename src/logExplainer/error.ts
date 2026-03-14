export function buildLogExplainerError(
  status: number,
  message: string
): Error & { status: number } {
  const err = new Error(message) as Error & { status: number }
  err.status = status
  return err
}
