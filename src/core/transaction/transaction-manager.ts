export interface TransactionManager<TUnitOfWork> {
  run<TResult>(operation: (unitOfWork: TUnitOfWork) => Promise<TResult>): Promise<TResult>;
}
