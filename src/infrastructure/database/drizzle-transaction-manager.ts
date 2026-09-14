import type { TransactionManager } from "../../core/transaction/transaction-manager";
import type { Database, DatabaseSession } from "./database";
import type { DatabaseObserver } from "./database-observer";

export type UnitOfWorkFactory<TUnitOfWork> = (session: DatabaseSession) => TUnitOfWork;

export class DrizzleTransactionManager<TUnitOfWork>
  implements TransactionManager<TUnitOfWork>
{
  constructor(
    private readonly database: Database,
    private readonly createUnitOfWork: UnitOfWorkFactory<TUnitOfWork>,
    private readonly observer?: DatabaseObserver,
  ) {}

  run<TResult>(operation: (unitOfWork: TUnitOfWork) => Promise<TResult>): Promise<TResult> {
    const execute = () =>
      this.database.transaction(async (transaction) =>
        operation(this.createUnitOfWork(transaction)),
      );

    return this.observer ? this.observer.transaction(execute) : execute();
  }
}
