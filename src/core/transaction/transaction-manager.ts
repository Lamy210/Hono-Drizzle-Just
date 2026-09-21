export type TransactionRetryMode = "never" | "safe";

export interface TransactionRunOptions {
  readonly retry?: TransactionRetryMode;
}

export interface TransactionManager<TUnitOfWork> {
  run<TResult>(
    operation: (unitOfWork: TUnitOfWork) => Promise<TResult>,
    options?: TransactionRunOptions,
  ): Promise<TResult>;
}
