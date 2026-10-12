export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public retryable = false,
  ) {
    super(message);
  }
}
export const requireValue = <T>(value: T | undefined): T => {
  if (value === undefined)
    throw new ApiError(404, "NOT_FOUND", "Запись не найдена");
  return value;
};
